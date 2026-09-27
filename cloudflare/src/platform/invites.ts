import { generateRandomString } from "better-auth/crypto";

import { createAuth } from "../auth/create-auth";
import type { PlatformPrincipal } from "../auth/live-authorization";
import {
  isPasswordResetConfigured,
  passwordResetActionUrl,
} from "../auth/password-reset";
import type { AuthActionEmailJob } from "../email/auth-email-job";
import { createAuthEmailJob, INVITE_LINK_VALID_HOURS } from "../email/auth-email-job";
import {
  abandonAuthEmailDelivery,
  prepareAuthEmailDeliveryRecord,
} from "../email/email-delivery-store";
import { readCanonicalOrigins } from "../lib/origins";

/**
 * Platform-issued password-set links (CP3-B) — the invitation flow the interim
 * credential model of provision-users.ts was waiting for, and the forced reset
 * of the migration (MIGRATION_MANIFEST §a): the importer creates identities
 * with no usable password, and each carried admin receives one of these.
 *
 * ── IT IS THE PASSWORD-RESET MECHANISM ──────────────────────────────────────
 * The token is a Better Auth reset token: a `verification` row whose identifier
 * is the hash of `reset-password:<token>` and whose value is the user id,
 * written through Better Auth's own adapter so the identifier hashing
 * (`storeIdentifier: "hashed"`) can never drift from what the reset endpoints
 * look up. The emailed link is the ordinary reset link
 * (`GET /api/auth/reset-password/:token`), the password is set through the
 * ordinary `POST /api/auth/reset-password`, and Better Auth consumes the row
 * atomically there — single use, and every session of the user is revoked on
 * success (create-auth.ts). Nothing on the consuming side knows invites exist.
 *
 * What differs from a self-service reset:
 *   - the token lives 72 hours (INVITE_TOKEN_TTL_SECONDS), not one. The
 *     ordinary reset's hour is Better Auth's `resetPasswordTokenExpiresIn` and
 *     is untouched: this module sets the expiry on its own row.
 *   - the link lands on the surface the identity uses — the platform page for a
 *     platform admin, the admin page for a tenant admin — taken from the
 *     canonical origin allowlist (password-reset.ts resetPageOrigin), never
 *     from the request.
 *   - issuing an invite deletes the previous unused invite's token in the same
 *     batch (identity_invites keeps the verification row id for exactly this).
 *   - the operator never sees the token or the link. The response names the
 *     user, the surface and the expiry; only the recipient's inbox gets the link.
 *
 * ── THE EMAIL ───────────────────────────────────────────────────────────────
 * The ledger kind is `password_reset` (0029's CHECK needs no new kind: the
 * ledger records a delivery, not its wording). The job carries
 * `variant: "invite"`, which selects the invite wording in auth-email-job.ts.
 * The job has its own 24-hour delivery window — the job validator's cap and
 * Resend's idempotency window — which is shorter than the token's life: an
 * invite whose email could not be delivered within a day is re-issued, not
 * resent.
 *
 * No rate limiter, as on every platform surface (see provision-users.ts): the
 * caller holds a live platform session, and the audit row names them.
 */

/** How long an invite's token is valid: what the invite email promises. */
export const INVITE_TOKEN_TTL_SECONDS = INVITE_LINK_VALID_HOURS * 60 * 60;
const INVITE_TOKEN_TTL_MS = INVITE_TOKEN_TTL_SECONDS * 1_000;

/** How long the email job may wait for delivery (auth-email-job.ts cap). */
export const INVITE_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Alphanumeric, like Better Auth's own reset tokens, and longer (it lives 72x as long). */
const INVITE_TOKEN_LENGTH = 32;

export type InviteSurface = "admin" | "platform";

/** Which surface an account type's link lands on; null ⇒ not invitable. */
export function inviteSurfaceFor(accountType: string | null): InviteSurface | null {
  if (accountType === "platform_admin") {
    return "platform";
  }
  return accountType === "tenant_admin" ? "admin" : null;
}

export interface IssuedInvite {
  expiresAt: string;
  surface: InviteSurface;
  userId: string;
}

export type InviteResult =
  | { invite: IssuedInvite; status: "ok" }
  | { status: "email_unavailable" | "not_found" | "not_invitable" };

/** Same gate as the reset surface: a queue to deliver through, an allowlist to build from. */
export function isInviteConfigured(env: Env): boolean {
  return isPasswordResetConfigured(env);
}

interface TargetRow {
  account_type: string | null;
  email: string;
  status: string | null;
  user_id: string;
}

const INVITABLE_TARGET_SQL = `EXISTS (
  SELECT 1 FROM identity_access
  WHERE user_id = ?
    AND status = 'active'
    AND account_type IN ('platform_admin', 'tenant_admin')
)`;

function logInviteFailure(reason: string, error?: unknown): void {
  // No recipient, no token, no link.
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : undefined,
      message: "invite email could not be enqueued",
      reason,
    }),
  );
}

/**
 * Issues an invite for `userId` at `now` (the token expires at now + 72 h).
 *
 * Invitable: an ACTIVE `platform_admin` or `tenant_admin` identity. Anything
 * else — suspended, print operator, ordinary, no identity at all — is
 * `not_invitable`. The eligibility is re-checked inside the batch that records
 * the invite, so an identity deactivated in between gets no invite.
 */
export async function issueInvite(
  env: Env,
  principal: PlatformPrincipal,
  userId: string,
  now: number,
): Promise<InviteResult> {
  const origins = readCanonicalOrigins(env);
  const queue = env.EMAIL_QUEUE;
  if (origins === null || queue === undefined) {
    // Unreachable through the route, which is gated on both.
    throw new Error("invite reached without its configuration");
  }

  const target = await env.DB
    .prepare(
      `SELECT u."id" AS user_id, u."email" AS email, a.account_type, a.status
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       WHERE u."id" = ?
       LIMIT 1`,
    )
    .bind(userId)
    .first<TargetRow>();

  if (target === null) {
    return { status: "not_found" };
  }

  const surface = inviteSurfaceFor(target.account_type);
  if (surface === null || target.status !== "active") {
    return { status: "not_invitable" };
  }

  const token = generateRandomString(INVITE_TOKEN_LENGTH, "a-z", "A-Z", "0-9");
  const expiresAt = now + INVITE_TOKEN_TTL_MS;

  // The job is built (and validated) before anything is written: an address
  // the email pipeline would refuse is not invitable, and leaves no token.
  let job: AuthActionEmailJob;
  try {
    job = createAuthEmailJob(
      {
        actionUrl: passwordResetActionUrl(env, origins, token, surface),
        expiresAt: Date.now() + INVITE_EMAIL_WINDOW_MS,
        kind: "password_reset",
        locale: "sv",
        recipient: target.email,
        variant: "invite",
      },
      env.AUTH_BASE_URL,
    );
  } catch {
    return { status: "not_invitable" };
  }

  const context = await createAuth(env).$context;
  const verification = await context.internalAdapter.createVerificationValue({
    expiresAt: new Date(expiresAt),
    identifier: `reset-password:${token}`,
    value: userId,
  });

  const inviteId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const expiresIso = new Date(expiresAt).toISOString();
  const inviteRecorded = {
    binds: [inviteId],
    sql: "EXISTS (SELECT 1 FROM identity_invites WHERE invite_id = ?)",
  };

  const recordInvite = async (): Promise<D1Result[]> => {
    const recordDelivery = await prepareAuthEmailDeliveryRecord(env.DB, job, job.createdAt);
    return env.DB.batch([
      // The previous unused invite dies with this one's birth: its token row is
      // deleted and it is marked superseded. Guarded like the insert, so a batch
      // that records no new invite also supersedes nothing.
      env.DB
        .prepare(
          `DELETE FROM "verification"
           WHERE "id" IN (
             SELECT verification_id FROM identity_invites
             WHERE user_id = ? AND status = 'issued'
           )
             AND ${INVITABLE_TARGET_SQL}`,
        )
        .bind(userId, userId),
      env.DB
        .prepare(
          `UPDATE identity_invites
           SET status = 'superseded', updated_at = MAX(updated_at, ?)
           WHERE user_id = ? AND status = 'issued' AND ${INVITABLE_TARGET_SQL}`,
        )
        .bind(nowIso, userId, userId),
      env.DB
        .prepare(
          `INSERT INTO identity_invites (
            invite_id, user_id, surface, status, verification_id, delivery_id,
            issued_by, expires_at, created_at, updated_at
          )
          SELECT ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?
          WHERE ${INVITABLE_TARGET_SQL}`,
        )
        .bind(
          inviteId,
          userId,
          surface,
          verification.id,
          job.deliveryId,
          principal.userId,
          expiresIso,
          nowIso,
          nowIso,
          userId,
        ),
      // Never the address, the token or the link.
      env.DB
        .prepare(
          `INSERT INTO audit_events (
            event_id, tenant_id, actor_user_id, action, resource_type,
            resource_id, reason, request_id, metadata_json, created_at
          )
          SELECT ?, NULL, ?, 'platform.user_invite', 'identity_access', ?, NULL, ?,
            json_object(
              'deliveryId', ?, 'expiresAt', ?, 'inviteId', ?, 'surface', ?
            ),
            ?
          WHERE ${inviteRecorded.sql}`,
        )
        .bind(
          crypto.randomUUID(),
          principal.userId,
          userId,
          crypto.randomUUID(),
          job.deliveryId,
          expiresIso,
          inviteId,
          surface,
          now,
          ...inviteRecorded.binds,
        ),
      recordDelivery(inviteRecorded),
    ]);
  };

  // The token row above was written outside this batch. If the batch FAULTS
  // (a throw, as opposed to the guarded no-op handled below), nothing
  // references the row and nobody holds its token — not exploitable, but it
  // would linger 72 hours. Remove it on a best-effort basis and rethrow the
  // original error unchanged.
  let results: D1Result[];
  try {
    results = await recordInvite();
  } catch (error) {
    try {
      await env.DB
        .prepare('DELETE FROM "verification" WHERE "id" = ?')
        .bind(verification.id)
        .run();
    } catch {
      // Best effort: the row expires on its own.
    }
    throw error;
  }

  // "Recorded" is changes > 0: D1's count includes rows a trigger writes.
  if ((results[2]?.meta.changes ?? 0) === 0) {
    // The identity stopped being invitable between the read and the batch.
    // The token was never sent anywhere; remove it anyway.
    await env.DB
      .prepare('DELETE FROM "verification" WHERE "id" = ?')
      .bind(verification.id)
      .run();
    return { status: "not_invitable" };
  }

  try {
    await queue.send(job, { contentType: "json" });
  } catch (error) {
    logInviteFailure("queue_unavailable", error);
    // Nobody will ever receive this token: close the ledger row and kill the
    // invite, so the operator's retry starts clean.
    try {
      await abandonAuthEmailDelivery(env.DB, job.deliveryId, "E_ENQUEUE", Date.now());
      await env.DB.batch([
        env.DB
          .prepare('DELETE FROM "verification" WHERE "id" = ?')
          .bind(verification.id),
        env.DB
          .prepare(
            `UPDATE identity_invites
             SET status = 'revoked', updated_at = MAX(updated_at, ?)
             WHERE invite_id = ? AND status = 'issued'`,
          )
          .bind(nowIso, inviteId),
      ]);
    } catch {
      // The next invite supersedes it; the reconciliation sweep owns the row.
    }
    return { status: "email_unavailable" };
  }

  return {
    invite: { expiresAt: expiresIso, surface, userId },
    status: "ok",
  };
}
