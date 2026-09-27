import type { TenantAdminPrincipal } from "../auth/live-authorization";

/**
 * The seller's acceptance of the platform terms (Plattformsvillkor + the
 * PUB-avtal annex) — the HARD checkout gate (migrations/0031).
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
 * shop — for a tenant with no acceptance of the current version. The public
 * storefront read says nothing about it.
 */

export interface TermsStatus {
  acceptedAt: string | null;
  currentVersion: string | null;
  /** SHA-256 of the current version's text; null when no version is published. */
  currentSha256: string | null;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/**
 * The current version (the latest published at or before `now`) and this
 * tenant's acceptance of it, in ONE read. No published version means nothing
 * can have been accepted: the gate stays closed.
 */
export async function readTermsStatus(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<TermsStatus> {
  const row = await db
    .prepare(
      `SELECT v.version AS version, v.sha256 AS sha256,
              (SELECT a.accepted_at FROM platform_terms_acceptances AS a
               WHERE a.tenant_id = ? AND a.terms_version = v.version) AS accepted_at
       FROM platform_terms_versions AS v
       WHERE v.published_at <= ?
       ORDER BY v.published_at DESC, v.version DESC
       LIMIT 1`,
    )
    .bind(tenantId, iso(now))
    .first<{ accepted_at: string | null; sha256: string; version: string }>();

  return {
    acceptedAt: row?.accepted_at ?? null,
    currentSha256: row?.sha256 ?? null,
    currentVersion: row?.version ?? null,
  };
}

/** THE gate. */
export async function hasAcceptedCurrentTerms(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<boolean> {
  return (await readTermsStatus(db, tenantId, now)).acceptedAt !== null;
}

const VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

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
    VERSION_PATTERN.test(termsVersion)
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

function bounded(value: string | null, max: number): string | null {
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
  if (principal.actingAs !== undefined) {
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
