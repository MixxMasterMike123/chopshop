import type { PlatformPrincipal, TenantAdminPrincipal } from "../auth/live-authorization";

/**
 * The seller's acceptance of the platform terms (Plattformsvillkor + the
 * PUB-avtal annex) — the HARD checkout gate (migrations/0031, 0037).
 *
 * Ported rule (Firebase src/utils/legalAcceptance.js):
 *   - the acceptance is EVIDENCE, append-only: who (the admin's user id), when,
 *     which version, plus where from (ip, user agent) and the hash of the text;
 *   - "accepted" means the CURRENT version (hasAcceptedCurrentPlatformTerms
 *     compares `platformTerms.version === PLATFORM_TERMS_VERSION`);
 *   - only the shop's own admin accepts. Firebase's PlatformTermsGate is never
 *     shown to platform users or impersonation; here an acting-as principal is
 *     refused outright: a platform user must not sign the seller's contract
 *     (plattformsvillkor § 1: the accepter vouches they may bind the Säljare).
 *
 * What is gated: `createCheckout` refuses — the same opaque 404 as an unknown
 * shop — unless `isTermsGateOpen`: the shop accepted the current version, or
 * it is inside the D47 grace period. The public storefront read says nothing
 * about it.
 *
 * ── D47 GRACE (with D54) ────────────────────────────────────────────────────
 * When a new version C is published, a shop that had accepted the IMMEDIATELY
 * PREVIOUS version P stays open for 14 days from C's publish time:
 *
 *     in grace  ⇔  not accepted C  AND  accepted P  AND  now < C.published_at + 14 d
 *
 * The window is HALF-OPEN, [C.published_at, C.published_at + 14 d): the
 * instant `published_at + 14 days` itself is OUTSIDE (closed). 14 days is
 * exactly 1 209 600 000 ms on the UTC timeline (no calendar or DST rule).
 * "Immediately previous" = the version right before C in publication order
 * (published_at, then version label); 0037's trigger makes that order strict
 * for every newly published version. A shop that never accepted, or whose
 * latest acceptance is two or more versions behind, gets NO grace (D54) —
 * even while the version it did accept would still have been in its own
 * 14 days. D48 stands: the payment route does not re-check the gate.
 */

/** 14 days, exactly (D47). */
export const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1_000;

/** Same grammar as 0031's CHECK on platform_terms_versions.version. */
export const TERMS_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

/** The archived terms text is capped like a legal-pages snapshot (0037). */
export const TERMS_TEXT_MAX_BYTES = 262_144;

export interface TermsStatus {
  /** When this tenant accepted the CURRENT version; null when it has not. */
  acceptedAt: string | null;
  /**
   * The latest version this tenant accepted, in publication order (among
   * versions published by `now`), whichever it is; null when none.
   */
  acceptedVersion: string | null;
  currentPublishedAt: string | null;
  /** SHA-256 of the current version's text; null when no version is published. */
  currentSha256: string | null;
  currentVersion: string | null;
  /**
   * `current.published_at + 14 d` when this tenant has not accepted the current
   * version but did accept the immediately previous one — also once that
   * instant has passed (then `inGrace` is false). Null otherwise.
   */
  graceDeadline: string | null;
  inGrace: boolean;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/** SHA-256 of a UTF-8 string or raw bytes, lowercase hex. */
export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface StatusRow {
  accepted_at: string | null;
  accepted_version: string | null;
  previous_accepted_at: string | null;
  published_at: string;
  sha256: string;
  version: string;
}

/**
 * The current version (the latest published at or before `now`), this
 * tenant's acceptance of it, of the immediately previous version, and its
 * latest accepted version — in ONE read. No published version means nothing
 * can have been accepted: the gate stays closed.
 */
export async function readTermsStatus(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<TermsStatus> {
  const row = await db
    .prepare(
      `WITH cur AS (
         SELECT version, sha256, published_at
         FROM platform_terms_versions
         WHERE published_at <= ?2
         ORDER BY published_at DESC, version DESC
         LIMIT 1
       )
       SELECT cur.version AS version, cur.sha256 AS sha256, cur.published_at AS published_at,
              (SELECT a.accepted_at FROM platform_terms_acceptances AS a
               WHERE a.tenant_id = ?1 AND a.terms_version = cur.version) AS accepted_at,
              (SELECT a.accepted_at FROM platform_terms_acceptances AS a
               WHERE a.tenant_id = ?1
                 AND a.terms_version = (
                   SELECT p.version FROM platform_terms_versions AS p
                   WHERE p.published_at < cur.published_at
                      OR (p.published_at = cur.published_at AND p.version < cur.version)
                   ORDER BY p.published_at DESC, p.version DESC
                   LIMIT 1
                 )) AS previous_accepted_at,
              (SELECT a.terms_version FROM platform_terms_acceptances AS a
               INNER JOIN platform_terms_versions AS v ON v.version = a.terms_version
               WHERE a.tenant_id = ?1 AND v.published_at <= ?2
               ORDER BY v.published_at DESC, v.version DESC
               LIMIT 1) AS accepted_version
       FROM cur`,
    )
    .bind(tenantId, iso(now))
    .first<StatusRow>();

  if (row === null) {
    return {
      acceptedAt: null,
      acceptedVersion: null,
      currentPublishedAt: null,
      currentSha256: null,
      currentVersion: null,
      graceDeadline: null,
      inGrace: false,
    };
  }

  let graceDeadline: string | null = null;
  let inGrace = false;
  if (row.accepted_at === null && row.previous_accepted_at !== null) {
    const deadline = Date.parse(row.published_at) + GRACE_PERIOD_MS;
    graceDeadline = iso(deadline);
    // Half-open: the deadline instant itself is outside the grace period.
    inGrace = now < deadline;
  }

  return {
    acceptedAt: row.accepted_at,
    acceptedVersion: row.accepted_version,
    currentPublishedAt: row.published_at,
    currentSha256: row.sha256,
    currentVersion: row.version,
    graceDeadline,
    inGrace,
  };
}

/** Strict: the shop accepted the CURRENT version (grace does not count). */
export async function hasAcceptedCurrentTerms(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<boolean> {
  return (await readTermsStatus(db, tenantId, now)).acceptedAt !== null;
}

/** THE checkout gate: the current version accepted, or inside the D47 grace. */
export async function isTermsGateOpen(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<boolean> {
  const status = await readTermsStatus(db, tenantId, now);
  return status.acceptedAt !== null || status.inGrace;
}

/**
 * Who may bind the seller: the shop's OWN admin, never a platform user acting
 * as the shop (plattformsvillkor § 1). The one check every seller acceptance
 * (platform terms and legal pages) goes through.
 */
export function maySignForSeller(principal: TenantAdminPrincipal): boolean {
  return principal.actingAs === undefined;
}

/** Strict body: exactly `{ termsVersion }`. */
export function parseAcceptTermsInput(body: unknown): { termsVersion: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  const termsVersion = (body as Record<string, unknown>).termsVersion;
  return keys.length === 1 &&
    keys[0] === "termsVersion" &&
    typeof termsVersion === "string" &&
    TERMS_VERSION_PATTERN.test(termsVersion)
    ? { termsVersion }
    : null;
}

export interface AcceptanceEvidence {
  ip: string | null;
  origin: string | null;
  userAgent: string | null;
}

export type AcceptTermsResult =
  | { acceptance: { acceptedAt: string; termsVersion: string }; status: "accepted" | "already_accepted" }
  /** The body named a version that is not the current one (stale page). */
  | { currentVersion: string | null; status: "not_current" }
  /** An acting-as principal: a platform user never accepts for the seller. */
  | { status: "forbidden" };

export function bounded(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

/**
 * Records the acceptance + its audit row in one batch. A second accept of the
 * same version (a double click, another admin of the shop) writes nothing and
 * answers with the FIRST acceptance: the evidence is who accepted first.
 */
export async function acceptPlatformTerms(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: { termsVersion: string },
  evidence: AcceptanceEvidence,
  now: number,
): Promise<AcceptTermsResult> {
  if (!maySignForSeller(principal)) {
    return { status: "forbidden" };
  }

  const status = await readTermsStatus(db, principal.tenantId, now);
  if (status.currentVersion === null || status.currentVersion !== input.termsVersion) {
    return { currentVersion: status.currentVersion, status: "not_current" };
  }
  if (status.acceptedAt !== null) {
    return {
      acceptance: { acceptedAt: status.acceptedAt, termsVersion: status.currentVersion },
      status: "already_accepted",
    };
  }

  const acceptanceId = crypto.randomUUID();
  const acceptedAt = iso(now);
  const evidenceJson = JSON.stringify({
    origin: bounded(evidence.origin, 200),
    termsSha256: status.currentSha256,
  });
  const inserted = await db.batch([
    db
      .prepare(
        `INSERT INTO platform_terms_acceptances (
           id, tenant_id, user_id, terms_version, accepted_at, ip, user_agent, evidence_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, terms_version) DO NOTHING`,
      )
      .bind(
        acceptanceId,
        principal.tenantId,
        principal.userId,
        status.currentVersion,
        acceptedAt,
        bounded(evidence.ip, 64),
        bounded(evidence.userAgent, 512),
        evidenceJson,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'legal.platform_terms.accept', 'platform_terms_acceptance', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM platform_terms_acceptances WHERE id = ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        acceptanceId,
        crypto.randomUUID(),
        JSON.stringify({ termsSha256: status.currentSha256, termsVersion: status.currentVersion }),
        now,
        acceptanceId,
      ),
  ]);

  if (inserted[0]?.meta.changes === 1) {
    return {
      acceptance: { acceptedAt, termsVersion: status.currentVersion },
      status: "accepted",
    };
  }

  // Another admin of the shop won the race: answer with their acceptance.
  const winner = await readTermsStatus(db, principal.tenantId, now);
  return {
    acceptance: {
      acceptedAt: winner.acceptedAt ?? acceptedAt,
      termsVersion: status.currentVersion,
    },
    status: "already_accepted",
  };
}

// ── publishing versions and archiving their text (platform only) ────────────

export interface TermsVersionView {
  /** True for the version that is current at `now`. */
  current: boolean;
  publishedAt: string;
  sha256: string;
  textArchived: boolean;
  version: string;
}

interface VersionRow {
  object_key: string | null;
  published_at: string;
  sha256: string;
  version: string;
}

const ISO_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The archive key 0037 pins by CHECK: content-addressed by (version, sha256). */
export function termsTextObjectKey(version: string, sha256: string): string {
  return `platform/legal/terms/${version}/${sha256}.txt`;
}

/**
 * The text as exact UTF-8 bytes, or null: a string of 1..TERMS_TEXT_MAX_BYTES
 * bytes with no lone surrogate (which UTF-8 cannot carry, so "the hash of the
 * text" would otherwise depend on the encoder's replacement rule).
 */
function termsTextBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || LONE_SURROGATE.test(value)) {
    return null;
  }
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= TERMS_TEXT_MAX_BYTES ? bytes : null;
}

export type PublishTermsInput = { publishedAt: string | null; text: string; version: string };

export type ParsedTermsBody<T> = { input: T; status: "ok" } | { status: "invalid" | "too_large" };

/** Strict body: `{ version, text, publishedAt? }` — publishedAt ISO with ms, UTC. */
export function parsePublishTermsInput(body: unknown): ParsedTermsBody<PublishTermsInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: "invalid" };
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ["publishedAt", "text", "version"].includes(key))) {
    return { status: "invalid" };
  }
  const { publishedAt, text, version } = record;
  if (typeof version !== "string" || !TERMS_VERSION_PATTERN.test(version)) {
    return { status: "invalid" };
  }
  if (
    publishedAt !== undefined &&
    (typeof publishedAt !== "string" ||
      !ISO_MS_PATTERN.test(publishedAt) ||
      Number.isNaN(Date.parse(publishedAt)) ||
      iso(Date.parse(publishedAt)) !== publishedAt)
  ) {
    return { status: "invalid" };
  }
  if (typeof text === "string" && new TextEncoder().encode(text).byteLength > TERMS_TEXT_MAX_BYTES) {
    return { status: "too_large" };
  }
  if (termsTextBytes(text) === null) {
    return { status: "invalid" };
  }
  return {
    input: { publishedAt: publishedAt ?? null, text: text as string, version },
    status: "ok",
  };
}

/** Strict body: exactly `{ text }`. */
export function parseAttachTermsTextInput(body: unknown): ParsedTermsBody<{ text: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: "invalid" };
  }
  const keys = Object.keys(body);
  const text = (body as Record<string, unknown>).text;
  if (keys.length !== 1 || keys[0] !== "text") {
    return { status: "invalid" };
  }
  if (typeof text === "string" && new TextEncoder().encode(text).byteLength > TERMS_TEXT_MAX_BYTES) {
    return { status: "too_large" };
  }
  return termsTextBytes(text) === null ? { status: "invalid" } : { input: { text: text as string }, status: "ok" };
}

function platformAudit(
  db: D1Database,
  principal: PlatformPrincipal,
  action: string,
  version: string,
  metadata: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, NULL, ?, ?, 'platform_terms_version', ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), principal.userId, action, version, crypto.randomUUID(), JSON.stringify(metadata), now);
}

function textRowStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  version: string,
  sha256: string,
  sizeBytes: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO platform_terms_texts (version, sha256, object_key, size_bytes, archived_by, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(version, sha256, termsTextObjectKey(version, sha256), sizeBytes, principal.userId, iso(now));
}

/**
 * Bytes first, then the rows. The key is content-addressed, so a put whose D1
 * batch then fails leaves an object that no row names and that a retry
 * rewrites with the SAME bytes; R2 verifies the SHA-256 on the way in.
 */
async function putTermsText(
  bucket: R2Bucket,
  version: string,
  sha256: string,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(termsTextObjectKey(version, sha256), bytes, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    sha256,
  });
}

function isConstraintFailure(error: unknown, pattern: RegExp): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return pattern.test(message);
}

async function latestPublishedAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(published_at) AS latest FROM platform_terms_versions")
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}

export async function listTermsVersions(db: D1Database, now: number): Promise<TermsVersionView[]> {
  const rows = await db
    .prepare(
      `SELECT v.version, v.published_at, v.sha256, t.object_key
       FROM platform_terms_versions AS v
       LEFT JOIN platform_terms_texts AS t ON t.version = v.version
       ORDER BY v.published_at DESC, v.version DESC`,
    )
    .all<VersionRow>();
  const nowIso = iso(now);
  const current = rows.results.find((row) => row.published_at <= nowIso)?.version ?? null;
  return rows.results.map((row) => ({
    current: row.version === current,
    publishedAt: row.published_at,
    sha256: row.sha256,
    textArchived: row.object_key !== null,
    version: row.version,
  }));
}

export type PublishTermsResult =
  | { status: "published"; version: TermsVersionView }
  | { status: "version_exists" }
  /** publishedAt is not strictly after every existing version. */
  | { latestPublishedAt: string | null; status: "not_after_latest" }
  /** publishedAt lies in the past. */
  | { status: "invalid" };

/**
 * Publishes a new version: the Worker hashes the text, archives it in the
 * private bucket, then inserts the version row, its text row and the audit
 * row in ONE batch — the evidence holds the hash, the archive the text.
 * publishedAt defaults to now; a later instant schedules the version.
 */
export async function publishTermsVersion(
  db: D1Database,
  bucket: R2Bucket,
  principal: PlatformPrincipal,
  input: PublishTermsInput,
  now: number,
): Promise<PublishTermsResult> {
  const publishedAt = input.publishedAt ?? iso(now);
  if (Date.parse(publishedAt) < now) {
    return { status: "invalid" };
  }

  const existing = await db
    .prepare("SELECT 1 AS one FROM platform_terms_versions WHERE version = ?")
    .bind(input.version)
    .first();
  if (existing !== null) {
    return { status: "version_exists" };
  }
  const latest = await latestPublishedAt(db);
  if (latest !== null && latest >= publishedAt) {
    return { latestPublishedAt: latest, status: "not_after_latest" };
  }

  const bytes = new TextEncoder().encode(input.text);
  const sha256 = await sha256Hex(bytes);
  await putTermsText(bucket, input.version, sha256, bytes);

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO platform_terms_versions (version, published_at, sha256, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(input.version, publishedAt, sha256, iso(now)),
      textRowStatement(db, principal, input.version, sha256, bytes.byteLength, now),
      platformAudit(
        db,
        principal,
        "legal.platform_terms.publish",
        input.version,
        { publishedAt, sha256, sizeBytes: bytes.byteLength },
        now,
      ),
    ]);
  } catch (error) {
    // A racing publish won: the same label, or an equal/later publish time.
    if (isConstraintFailure(error, /UNIQUE constraint failed|PRIMARY KEY/)) {
      return { status: "version_exists" };
    }
    if (isConstraintFailure(error, /published after the latest existing version/)) {
      return { latestPublishedAt: await latestPublishedAt(db), status: "not_after_latest" };
    }
    throw error;
  }

  return {
    status: "published",
    version: {
      current: publishedAt <= iso(now),
      publishedAt,
      sha256,
      textArchived: true,
      version: input.version,
    },
  };
}

export type AttachTermsTextResult =
  | { status: "archived" | "already_archived"; version: Omit<TermsVersionView, "current"> }
  | { status: "not_found" }
  /** The supplied text does not hash to the version's stored sha256. */
  | { expectedSha256: string; status: "hash_mismatch"; suppliedSha256: string };

/**
 * Attaches the text of an EXISTING version (the 0031 seed has none) — only
 * when its SHA-256 equals the hash the version already holds. The version row
 * itself is never touched; 0037's trigger re-checks the hash in the database.
 */
export async function attachTermsText(
  db: D1Database,
  bucket: R2Bucket,
  principal: PlatformPrincipal,
  version: string,
  text: string,
  now: number,
): Promise<AttachTermsTextResult> {
  const row = await db
    .prepare(
      `SELECT v.version, v.published_at, v.sha256, t.object_key
       FROM platform_terms_versions AS v
       LEFT JOIN platform_terms_texts AS t ON t.version = v.version
       WHERE v.version = ?`,
    )
    .bind(version)
    .first<VersionRow>();
  if (row === null) {
    return { status: "not_found" };
  }

  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== row.sha256) {
    return { expectedSha256: row.sha256, status: "hash_mismatch", suppliedSha256: sha256 };
  }
  const view = (): Omit<TermsVersionView, "current"> => ({
    publishedAt: row.published_at,
    sha256: row.sha256,
    textArchived: true,
    version: row.version,
  });
  if (row.object_key !== null) {
    return { status: "already_archived", version: view() };
  }

  await putTermsText(bucket, version, sha256, bytes);
  try {
    await db.batch([
      textRowStatement(db, principal, version, sha256, bytes.byteLength, now),
      platformAudit(
        db,
        principal,
        "legal.platform_terms.archive_text",
        version,
        { sha256, sizeBytes: bytes.byteLength },
        now,
      ),
    ]);
  } catch (error) {
    if (isConstraintFailure(error, /UNIQUE constraint failed|PRIMARY KEY/)) {
      return { status: "already_archived", version: view() };
    }
    throw error;
  }
  return { status: "archived", version: view() };
}

export type TermsTextRead =
  | { status: "not_found" }
  | {
      publishedAt: string;
      sha256: string;
      status: "ok";
      /** null when no text is archived for this version. */
      text: string | null;
      version: string;
    };

/**
 * One version's archived text. The bytes are re-hashed on the way out: an
 * archive that no longer matches its evidence is a fault, never served.
 * A version with a text row but no bucket or no object throws the same way.
 */
export async function readTermsText(
  db: D1Database,
  bucket: R2Bucket | undefined,
  version: string,
): Promise<TermsTextRead> {
  const row = await db
    .prepare(
      `SELECT v.version, v.published_at, v.sha256, t.object_key
       FROM platform_terms_versions AS v
       LEFT JOIN platform_terms_texts AS t ON t.version = v.version
       WHERE v.version = ?`,
    )
    .bind(version)
    .first<VersionRow>();
  if (row === null) {
    return { status: "not_found" };
  }
  if (row.object_key === null) {
    return { publishedAt: row.published_at, sha256: row.sha256, status: "ok", text: null, version: row.version };
  }

  const object = await bucket?.get(row.object_key);
  if (object === undefined || object === null) {
    throw new Error(`archived terms text missing for version ${row.version}`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== row.sha256) {
    throw new Error(`archived terms text does not match its hash for version ${row.version}`);
  }
  return {
    publishedAt: row.published_at,
    sha256: row.sha256,
    status: "ok",
    text: new TextDecoder().decode(bytes),
    version: row.version,
  };
}
