import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { issueInvite } from "./invites";
import { createInvitedUser, parseEmail } from "./provision-users";
import { ownPasswordSql } from "./user-directory";

/**
 * A shop's own admins (CP5-WC, decision D100): the list, the invite and the
 * revoke a seller performs on the people who administer THEIR shop.
 *
 * ── WHAT IS REUSED, AND WHAT IS NOT ─────────────────────────────────────────
 * Reused unchanged from the platform's identity surface (CP3-B):
 *   - the address rule: provision-users.ts `parseEmail`;
 *   - the identity creation: provision-users.ts `createInvitedUser` (the user,
 *     its password-less credential account, the `identity_access` row and its
 *     `platform.user_provision` audit row, in one batch), as a `tenant_admin`;
 *   - the invite: invites.ts `issueInvite` (the 72-hour password-set link on
 *     the reset mechanism, its ledger row, its `platform.user_invite` audit
 *     row, the queued job), whose link lands on the ADMIN origin because the
 *     identity is a tenant admin (inviteSurfaceFor).
 * Both read only the actor's user id; their principal parameter admits a
 * TenantAdminPrincipal beside the PlatformPrincipal. Their own audit rows
 * (`platform.user_provision`, `platform.user_invite`) name the actor but not
 * an acting-as grant: the grant id is on this module's membership row, written
 * in the grant's batch.
 *
 * NOT reused: provision-tenants.ts `grantTenantAdmin` and user-lifecycle.ts
 * `revokeTenantAdmin`. A seller's grant and revoke carry guards the platform's
 * do not — the cap of active admins, "already a member" as a refusal rather
 * than an idempotent success, "not yourself", "not the last admin" — and those
 * guards must sit in the WHERE of the one write that decides (the lifecycle
 * pattern of user-lifecycle.ts), or two concurrent requests both pass them.
 * Their audit rows also carry the acting-as grant id (auditMetadataJson),
 * which the platform functions cannot write.
 *
 * ── THE NEW IDENTITY HAS NO PASSWORD ────────────────────────────────────────
 * createInvitedUser writes the identity password-less from its first visible
 * moment — exactly what the importer creates (MIGRATION_MANIFEST §a): it
 * cannot sign in until the invite's link sets a password. (Until CP5-WJ4 a
 * random password was written first and cleared by the grant batch; a
 * concurrent invite of the same address could read that throwaway as a
 * password the person had set, win the grant and send no invite.)
 *
 * "Has set a password of their own" is user-directory.ts `ownPasswordSql`: a
 * password that no invite came after. `invited` in the list is its negation,
 * and an invite is sent exactly when it is false — so someone left with a
 * password nobody chose by the earlier flow still gets a link.
 *
 * ── WHAT THE ANSWER TO AN INVITE DOES NOT SAY ───────────────────────────────
 * An address that already administers ANOTHER shop gains a membership here
 * (one person, several shops). The 201 is built from the request and the
 * clock only — never from the stored name, the stored creation time or
 * whether the person has set a password — so it is byte-shaped the same
 * whether the address was known or not. An address held by any other kind of
 * account (a platform admin, a print operator, a customer, a suspended
 * identity, a user without an identity) is one refusal, `not_addable`, which
 * says nothing about which.
 */

/** The most ACTIVE admins one shop may have (active membership, active identity). */
export const TENANT_ADMIN_CAP = 20;

/** The list's bound. The cap keeps a shop far below it. */
export const MEMBER_LIST_LIMIT = 100;

const NAME_MAX_LENGTH = 100;
const NAME_FORBIDDEN_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const INVITE_KEYS = ["email", "name"] as const;

export interface TenantMember {
  email: string;
  /** The person has not set a password of their own: the invite's link is still owed. */
  invited: boolean;
  joinedAt: string;
  name: string;
  self: boolean;
  /** The identity's state: an operator may have suspended the account. */
  status: "active" | "suspended";
  userId: string;
}

export interface InviteMemberInput {
  email: string;
  name: string;
}

export type MemberRefusal =
  | "already_member"
  | "cannot_revoke_self"
  | "last_admin"
  | "member_limit"
  | "not_addable";

export type InviteMemberResult =
  | { member: TenantMember; status: "ok" }
  | { reason: MemberRefusal; status: "refused" }
  | { status: "email_unavailable" | "invalid" };

export type RevokeMemberResult =
  | { status: "not_found" | "ok" }
  | { reason: MemberRefusal; status: "refused" };

/**
 * An admin who COUNTS: an active admin membership of an active tenant-admin
 * identity. The list's `status`, the cap and the last-admin rule all use it,
 * so what the seller sees and what the guards count are the same people.
 * `m` is the membership alias; the identity is looked up by its user id.
 */
const COUNTING_ADMIN = `m.role = 'admin'
  AND m.status = 'active'
  AND EXISTS (
    SELECT 1 FROM identity_access AS counted
    WHERE counted.user_id = m.user_id
      AND counted.account_type = 'tenant_admin'
      AND counted.status = 'active'
  )`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > NAME_MAX_LENGTH) {
    return null;
  }
  // Refused, not trimmed: what is stored is what was sent.
  return value.trim().length === 0 ||
    value !== value.trim() ||
    NAME_FORBIDDEN_PATTERN.test(value)
    ? null
    : value;
}

/** `{ email, name }`, both required, nothing else. */
export function parseInviteMemberInput(body: unknown): InviteMemberInput | null {
  if (
    !isPlainObject(body) ||
    !Object.keys(body).every((key) => (INVITE_KEYS as readonly string[]).includes(key))
  ) {
    return null;
  }
  const email = parseEmail(body.email);
  const name = parseName(body.name);
  return email === null || name === null ? null : { email, name };
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

interface MemberRow {
  created_at: number;
  email: string;
  identity_status: string;
  name: string;
  own_password: number;
  user_id: string;
}

/**
 * The shop's active admin memberships, oldest first. Named columns; the one
 * fact derived from `account` is computed inside SQL (no column of it leaves
 * the database), the same fact the platform directory's `invite.pending`
 * negates (user-directory.ts ownPasswordSql). Nothing about any other shop is
 * selected.
 */
export async function listTenantMembers(
  db: D1Database,
  principal: TenantAdminPrincipal,
): Promise<TenantMember[]> {
  const rows = await db
    .prepare(
      `SELECT m.user_id AS user_id, m.created_at AS created_at,
         u."email" AS email, u."name" AS name, a.status AS identity_status,
         ${ownPasswordSql("m.user_id")} AS own_password
       FROM tenant_memberships AS m
       INNER JOIN "user" AS u ON u."id" = m.user_id
       INNER JOIN identity_access AS a ON a.user_id = m.user_id
       WHERE m.tenant_id = ?
         AND m.role = 'admin'
         AND m.status = 'active'
         AND a.account_type = 'tenant_admin'
       ORDER BY m.created_at, m.membership_id
       LIMIT ?`,
    )
    .bind(principal.tenantId, MEMBER_LIST_LIMIT)
    .all<MemberRow>();

  return rows.results.map((row) => ({
    email: row.email,
    invited: row.own_password !== 1,
    joinedAt: isoOf(row.created_at),
    name: row.name,
    self: row.user_id === principal.userId,
    status: row.identity_status === "active" ? "active" : "suspended",
    userId: row.user_id,
  }));
}

interface KnownAddressRow {
  account_type: string | null;
  identity_status: string | null;
  membership_status: string | null;
  own_password: number;
  user_id: string;
}

async function readKnownAddress(
  db: D1Database,
  tenantId: string,
  email: string,
): Promise<KnownAddressRow | null> {
  return db
    .prepare(
      `SELECT u."id" AS user_id, a.account_type AS account_type,
         a.status AS identity_status,
         (SELECT m.status FROM tenant_memberships AS m
          WHERE m.tenant_id = ? AND m.user_id = u."id" AND m.role = 'admin'
          LIMIT 1) AS membership_status,
         ${ownPasswordSql('u."id"')} AS own_password
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       WHERE u."email" = ?
       LIMIT 1`,
    )
    .bind(tenantId, email)
    .first<KnownAddressRow>();
}

/** Refusals decided by what the address already is; null ⇒ addable. */
function refusalFor(row: KnownAddressRow): MemberRefusal | null {
  if (row.account_type !== "tenant_admin" || row.identity_status !== "active") {
    return "not_addable";
  }
  return row.membership_status === "active" ? "already_member" : null;
}

async function countingAdmins(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tenant_memberships AS m
       WHERE m.tenant_id = ? AND ${COUNTING_ADMIN}`,
    )
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Makes `userId` an admin of the principal's shop in ONE guarded write: the
 * shop is active, the identity is an active tenant admin, the person is not
 * already an active admin here, and fewer than TENANT_ADMIN_CAP admins count.
 * A previous (revoked or suspended) membership row is re-activated — the
 * (tenant, user, role) key is unique — otherwise one is inserted. The audit
 * row is keyed on the decision's stamp, so a refused grant records nothing.
 *
 * `newIdentity`: the identity was created by this request (the audit says
 * so). It was created password-less and named from the request, so a fresh
 * identity that ends up with no membership is exactly an imported one:
 * password-less, inert, addable later.
 */
async function grantMembership(
  db: D1Database,
  principal: TenantAdminPrincipal,
  userId: string,
  newIdentity: boolean,
  now: number,
): Promise<"ok" | MemberRefusal> {
  const changeId = crypto.randomUUID();
  const tenantId = principal.tenantId;

  const existing = await db
    .prepare(
      `SELECT membership_id, status FROM tenant_memberships
       WHERE tenant_id = ? AND user_id = ? AND role = 'admin'
       LIMIT 1`,
    )
    .bind(tenantId, userId)
    .first<{ membership_id: string; status: string }>();

  const guards = `EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND status = 'active')
    AND EXISTS (
      SELECT 1 FROM identity_access
      WHERE user_id = ? AND account_type = 'tenant_admin' AND status = 'active'
    )
    AND (SELECT COUNT(*) FROM tenant_memberships AS m
         WHERE m.tenant_id = ? AND ${COUNTING_ADMIN}) < ?`;
  const guardBinds = [tenantId, userId, tenantId, TENANT_ADMIN_CAP];

  const decision =
    existing === null
      ? db
          .prepare(
            `INSERT INTO tenant_memberships (
              membership_id, tenant_id, user_id, role, status, created_at, updated_at,
              status_change_id
            )
            SELECT ?, ?, ?, 'admin', 'active', ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM tenant_memberships
                WHERE tenant_id = ? AND user_id = ? AND role = 'admin'
              )
              AND ${guards}`,
          )
          .bind(
            crypto.randomUUID(),
            tenantId,
            userId,
            now,
            now,
            changeId,
            tenantId,
            userId,
            ...guardBinds,
          )
      : db
          .prepare(
            `UPDATE tenant_memberships
             SET status = 'active',
                 updated_at = MAX(updated_at, ?),
                 status_change_id = ?
             WHERE membership_id = ?
               AND status = ?
               AND status <> 'active'
               AND ${guards}`,
          )
          .bind(now, changeId, existing.membership_id, existing.status, ...guardBinds);

  const statements: D1PreparedStatement[] = [
    decision,
    // Never the address or the name: the user id is the fact.
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, reason, request_id, metadata_json, created_at
        )
        SELECT ?, tenant_id, ?, ?, 'tenant_membership', membership_id, NULL, ?, ?, ?
        FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND role = 'admin' AND status_change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        existing === null ? "tenant.admin_grant" : "tenant.admin_reactivate",
        crypto.randomUUID(),
        auditMetadataJson(principal, {
          changeId,
          newIdentity,
          ...(existing === null ? {} : { previousStatus: existing.status }),
          surface: "admin",
          userId,
        }),
        now,
        tenantId,
        userId,
        changeId,
      ),
  ];

  const [decided] = await db.batch(statements);
  // "Matched" is changes > 0: D1 counts rows a trigger writes as well.
  if ((decided?.meta.changes ?? 0) > 0) {
    return "ok";
  }

  // Refused. The write decided; these reads only name the reason.
  const state = await db
    .prepare(
      `SELECT a.account_type, a.status AS identity_status, m.status AS membership_status
       FROM identity_access AS a
       LEFT JOIN tenant_memberships AS m
         ON m.user_id = a.user_id AND m.tenant_id = ? AND m.role = 'admin'
       WHERE a.user_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, userId)
    .first<{ account_type: string; identity_status: string; membership_status: string | null }>();
  if (state === null || state.account_type !== "tenant_admin" || state.identity_status !== "active") {
    return "not_addable";
  }
  if (state.membership_status === "active") {
    return "already_member";
  }
  return (await countingAdmins(db, tenantId)) >= TENANT_ADMIN_CAP
    ? "member_limit"
    : "not_addable";
}

/**
 * `POST /v1/admin/members`. The caller has authorized the principal, checked
 * the origin and the invite configuration, and parsed the body.
 */
export async function inviteTenantMember(
  env: Env,
  principal: TenantAdminPrincipal,
  input: InviteMemberInput,
  now: number,
): Promise<InviteMemberResult> {
  let known = await readKnownAddress(env.DB, principal.tenantId, input.email);
  if (known !== null) {
    const refusal = refusalFor(known);
    if (refusal !== null) {
      return { reason: refusal, status: "refused" };
    }
  }

  // Before an identity is created for a shop that has no room for it. Not the
  // decision (the grant's WHERE is); it spares the common case an orphan.
  if ((await countingAdmins(env.DB, principal.tenantId)) >= TENANT_ADMIN_CAP) {
    return { reason: "member_limit", status: "refused" };
  }

  let userId: string;
  let newIdentity = false;
  let ownPassword: boolean;

  if (known === null) {
    const created = await createInvitedUser(
      env,
      principal,
      { accountType: "tenant_admin", email: input.email, name: input.name },
      now,
    );
    if (created.status === "invalid") {
      // An address the sign-in would refuse: nothing was written.
      return { status: "invalid" };
    }
    if (created.status === "ok") {
      userId = created.user.userId;
      newIdentity = true;
      ownPassword = false;
    } else {
      // A concurrent request created the address first: take what it is now.
      // It is complete (created in one batch) and, if just created, has no
      // password — so whichever request wins the grant below sends the link.
      known = await readKnownAddress(env.DB, principal.tenantId, input.email);
      const refusal = known === null ? "not_addable" : refusalFor(known);
      if (known === null || refusal !== null) {
        return { reason: refusal ?? "not_addable", status: "refused" };
      }
      userId = known.user_id;
      ownPassword = known.own_password === 1;
    }
  } else {
    userId = known.user_id;
    ownPassword = known.own_password === 1;
  }

  const granted = await grantMembership(env.DB, principal, userId, newIdentity, now);
  if (granted !== "ok") {
    return { reason: granted, status: "refused" };
  }

  // Someone who has not set a password of their own gets the link (re-issuing
  // kills any earlier unused one). Someone who has one signs in as before.
  if (!ownPassword) {
    const invite = await issueInvite(env, principal, userId, now);
    if (invite.status === "email_unavailable") {
      return { status: "email_unavailable" };
    }
    if (invite.status !== "ok") {
      // The identity stopped being invitable after the grant (suspended in
      // between): the membership stands and counts for nothing.
      return { reason: "not_addable", status: "refused" };
    }
  }

  // From the request and the clock only (see the module comment).
  return {
    member: {
      email: input.email,
      invited: true,
      joinedAt: isoOf(now),
      name: input.name,
      self: false,
      status: "active",
      userId,
    },
    status: "ok",
  };
}

/**
 * `POST /v1/admin/members/:userId/revoke`: that person's admin membership of
 * THIS shop, revoked in one guarded write — the membership is active, it is
 * not the caller's own, and ANOTHER admin who counts remains. D1 runs one
 * statement at a time against one database, so of two concurrent revokes of
 * the last two admins the second sees the first's revocation and matches
 * nothing. The identity, its sessions and its other shops are untouched:
 * authorizeTenantAdmin re-reads the membership on every request, so the
 * revoked person's next request naming this shop is refused.
 */
export async function revokeTenantMember(
  db: D1Database,
  principal: TenantAdminPrincipal,
  userId: string,
  now: number,
): Promise<RevokeMemberResult> {
  const tenantId = principal.tenantId;
  const isMember = async () =>
    (await db
      .prepare(
        `SELECT 1 AS present FROM tenant_memberships
         WHERE tenant_id = ? AND user_id = ? AND role = 'admin' AND status = 'active'
         LIMIT 1`,
      )
      .bind(tenantId, userId)
      .first<{ present: number }>()) !== null;

  if (userId === principal.userId) {
    return (await isMember())
      ? { reason: "cannot_revoke_self", status: "refused" }
      : { status: "not_found" };
  }

  const changeId = crypto.randomUUID();
  const [decision] = await db.batch([
    db
      .prepare(
        `UPDATE tenant_memberships
         SET status = 'revoked',
             updated_at = MAX(updated_at, ?),
             status_change_id = ?
         WHERE tenant_id = ?
           AND user_id = ?
           AND role = 'admin'
           AND status = 'active'
           AND user_id <> ?
           AND EXISTS (
             SELECT 1 FROM tenant_memberships AS m
             WHERE m.tenant_id = ? AND m.user_id <> ? AND ${COUNTING_ADMIN}
           )`,
      )
      .bind(now, changeId, tenantId, userId, principal.userId, tenantId, userId),
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, reason, request_id, metadata_json, created_at
        )
        SELECT ?, tenant_id, ?, 'tenant.admin_revoke', 'tenant_membership',
          membership_id, NULL, ?, ?, ?
        FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND role = 'admin' AND status_change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { changeId, surface: "admin", userId }),
        now,
        tenantId,
        userId,
        changeId,
      ),
  ]);

  if ((decision?.meta.changes ?? 0) > 0) {
    return { status: "ok" };
  }
  return (await isMember())
    ? { reason: "last_admin", status: "refused" }
    : { status: "not_found" };
}
