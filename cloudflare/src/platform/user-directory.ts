import { decodeSegment } from "../lib/responses";
import { parseTenantIdPathSegment } from "./provision-tenants";

/**
 * The platform's user directory (CP3-B): who has an identity on this platform,
 * of which kind, in which state, and with which shops.
 *
 * PLATFORM-ONLY, and deliberately narrow. Every column is named in the SELECT
 * list. Nothing is read from Better Auth's `verification` (reset tokens) or
 * `session` tables. From `account` (password hashes, provider tokens) exactly
 * TWO facts are derived, inside SQL: whether a credential account with a
 * non-null password exists (`hasPassword`), and whether one was set since the
 * latest invite (`invite.pending`, see ownPasswordSql). No column of `account`
 * is selected into the Worker — each query returns 0 or 1.
 *
 * The view is the identity's public facts: id, email, name, kind, status,
 * creation time, its memberships, whether it can sign in with a password, and
 * its latest invite (status and times only — never the token, the
 * verification row id or the delivery id).
 *
 * Users without an `identity_access` row (a provisioning race's inert orphan,
 * see provision-users.ts) are listed with `accountType` and `status` null, so an
 * operator can find them.
 */

export type AccountType = "ordinary" | "platform_admin" | "print_operator" | "tenant_admin";
export type IdentityStatus = "active" | "revoked" | "suspended";

const ACCOUNT_TYPES: readonly AccountType[] = [
  "ordinary",
  "platform_admin",
  "print_operator",
  "tenant_admin",
];

export interface DirectoryMembership {
  role: string;
  status: string;
  tenantId: string;
}

export interface DirectoryPrintMembership {
  status: string;
  tenantId: string;
}

/**
 * The user's latest `identity_invites` row. `status` is the row's own:
 * `issued` means not superseded and not revoked — it does NOT say whether the
 * link was used (Better Auth consumes the token without telling this table).
 * `pending` answers that: true while no password has been set since this
 * invite was issued (OWN_PASSWORD_SQL below) — the person has not taken it up,
 * whether the link is live, expired, or was revoked because its mail could not
 * be queued. `expired: true` is present only on an `issued` invite whose 72
 * hours have passed.
 */
export interface DirectoryInvite {
  createdAt: string;
  expired?: true;
  expiresAt: string;
  pending: boolean;
  status: "issued" | "revoked" | "superseded";
}

/**
 * SQL, true when the person has set a password of their own: a credential
 * account with a non-null password exists, and no invite was issued at or
 * after the password's last change (Better Auth stamps the account's
 * `updatedAt` when its reset endpoint sets the password). `:user` is the SQL
 * expression of the user id. Evaluated inside SQLite: only 0 or 1 leaves it.
 *
 * Why not "a non-null password exists" alone (`hasPassword`): until CP5-WJ4
 * the console and the shop's invite created every new admin with a random
 * password nobody knew (cleared later, or never), so a password could exist
 * that the person never chose. An identity invited after its password was
 * written has not chosen one until it uses an invite. Identities created now
 * have no password at all until then (provision-users.ts createInvitedUser),
 * so for them the two facts agree.
 *
 * Both times are ISO-8601 text on every writer (Better Auth's D1 adapter, the
 * importer, createInvitedUser; identity_invites' CHECK). Were a password's
 * time ever not text, SQLite orders text above it: the fact reads false and
 * the person is offered an invite — never the other way round.
 */
export function ownPasswordSql(user: string): string {
  return `EXISTS (
    SELECT 1 FROM "account" AS own_credential
    WHERE own_credential."userId" = ${user}
      AND own_credential."providerId" = 'credential'
      AND own_credential."password" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM identity_invites AS own_invite
        WHERE own_invite.user_id = own_credential."userId"
          AND own_invite.created_at >= own_credential."updatedAt"
      )
  )`;
}

export interface DirectoryUser {
  accountType: AccountType | null;
  createdAt: string;
  email: string;
  /** A credential account with a non-null password exists. */
  hasPassword: boolean;
  invite: DirectoryInvite | null;
  memberships: DirectoryMembership[];
  name: string;
  printMemberships: DirectoryPrintMembership[];
  status: IdentityStatus | null;
  userId: string;
}

export interface UserListQuery {
  accountType: AccountType | null;
  /** The last user id of the previous page; the list is ordered by user id. */
  cursor: string | null;
  limit: number;
  tenantId: string | null;
}

export const USER_LIST_LIMIT = 50;
const MAX_USER_LIST_LIMIT = 100;
/** D1 bound-parameter budget (PLAN §2.7): IN (…) lists are chunked. */
const IN_CHUNK = 90;

/**
 * A user id as it may appear in a path or a cursor. Better Auth mints 32
 * alphanumeric characters; the importer's ids are UUID-shaped. Anything outside
 * this alphabet is refused before any database work.
 */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value);
}

/** A raw path segment → a user id, decoded exactly once, or null. */
export function parseUserIdSegment(raw: string): string | null {
  const decoded = decodeSegment(raw);
  return decoded !== null && isUserId(decoded) ? decoded : null;
}

/**
 * `?accountType=&tenantId=&cursor=&limit=`, all optional. An unknown key or a
 * malformed value is a 400, never silently ignored: a typo in a filter must not
 * turn into "every user".
 */
export function parseUserListQuery(url: URL): UserListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["accountType", "cursor", "limit", "tenantId"].includes(key)) {
      return null;
    }
  }
  for (const key of ["accountType", "cursor", "limit", "tenantId"]) {
    if (params.getAll(key).length > 1) {
      return null;
    }
  }

  const accountTypeRaw = params.get("accountType");
  if (
    accountTypeRaw !== null &&
    !(ACCOUNT_TYPES as readonly string[]).includes(accountTypeRaw)
  ) {
    return null;
  }

  const tenantIdRaw = params.get("tenantId");
  const tenantId = tenantIdRaw === null ? null : parseTenantIdPathSegment(tenantIdRaw);
  if (tenantIdRaw !== null && tenantId === null) {
    return null;
  }

  const cursor = params.get("cursor");
  if (cursor !== null && !isUserId(cursor)) {
    return null;
  }

  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? USER_LIST_LIMIT : Number(limitRaw);
  if (
    (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) ||
    limit < 1 ||
    limit > MAX_USER_LIST_LIMIT
  ) {
    return null;
  }

  return {
    accountType: accountTypeRaw as AccountType | null,
    cursor,
    limit,
    tenantId,
  };
}

interface UserRow {
  account_type: AccountType | null;
  created_at: number | string;
  email: string;
  has_password: number;
  name: string;
  own_password: number;
  status: IdentityStatus | null;
  user_id: string;
}

// The one SELECT list every directory read uses. Better Auth's "user" table
// holds no secret (credentials live in "account"), and even so every column is
// named rather than taken with *. `has_password` and `own_password` are the
// ONLY things derived from "account": EXISTS evaluated inside SQLite, so no
// column of it leaves the database — the Worker receives 0 or 1.
const USER_COLUMNS = `u."id" AS user_id, u."email" AS email, u."name" AS name,
  u."createdAt" AS created_at, a.account_type AS account_type, a.status AS status,
  EXISTS (
    SELECT 1 FROM "account" AS credential
    WHERE credential."userId" = u."id"
      AND credential."providerId" = 'credential'
      AND credential."password" IS NOT NULL
  ) AS has_password,
  ${ownPasswordSql('u."id"')} AS own_password`;

/**
 * Better Auth stores dates through its SQLite adapter as ISO strings; a row
 * written by another path may hold milliseconds. Either becomes ISO-8601 UTC.
 */
function isoTime(value: number | string): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

interface InviteRow {
  created_at: string;
  expires_at: string;
  status: DirectoryInvite["status"];
  user_id: string;
}

async function attachDetails(
  db: D1Database,
  rows: UserRow[],
  now: number,
): Promise<DirectoryUser[]> {
  const memberships = new Map<string, DirectoryMembership[]>();
  const printMemberships = new Map<string, DirectoryPrintMembership[]>();
  const invites = new Map<string, Omit<DirectoryInvite, "pending">>();

  for (let start = 0; start < rows.length; start += IN_CHUNK) {
    const ids = rows.slice(start, start + IN_CHUNK).map((row) => row.user_id);
    const marks = ids.map(() => "?").join(", ");

    const tenantRows = await db
      .prepare(
        `SELECT user_id, tenant_id, role, status
         FROM tenant_memberships
         WHERE user_id IN (${marks})
         ORDER BY user_id, tenant_id, role`,
      )
      .bind(...ids)
      .all<{ role: string; status: string; tenant_id: string; user_id: string }>();
    for (const row of tenantRows.results) {
      const list = memberships.get(row.user_id) ?? [];
      list.push({ role: row.role, status: row.status, tenantId: row.tenant_id });
      memberships.set(row.user_id, list);
    }

    const printRows = await db
      .prepare(
        `SELECT user_id, tenant_id, status
         FROM print_memberships
         WHERE user_id IN (${marks})
         ORDER BY user_id, tenant_id`,
      )
      .bind(...ids)
      .all<{ status: string; tenant_id: string; user_id: string }>();
    for (const row of printRows.results) {
      const list = printMemberships.get(row.user_id) ?? [];
      list.push({ status: row.status, tenantId: row.tenant_id });
      printMemberships.set(row.user_id, list);
    }

    // The latest invite per user: newest created_at, the live (issued) row
    // first on a tie. Status and times only — the verification row id and the
    // delivery id are never selected.
    const inviteRows = await db
      .prepare(
        `SELECT user_id, status, expires_at, created_at
         FROM (
           SELECT user_id, status, expires_at, created_at,
             ROW_NUMBER() OVER (
               PARTITION BY user_id
               ORDER BY created_at DESC, status = 'issued' DESC, invite_id DESC
             ) AS position
           FROM identity_invites
           WHERE user_id IN (${marks})
         )
         WHERE position = 1`,
      )
      .bind(...ids)
      .all<InviteRow>();
    for (const row of inviteRows.results) {
      invites.set(row.user_id, {
        createdAt: row.created_at,
        ...(row.status === "issued" && Date.parse(row.expires_at) <= now
          ? { expired: true as const }
          : {}),
        expiresAt: row.expires_at,
        status: row.status,
      });
    }
  }

  return rows.map((row) => {
    const invite = invites.get(row.user_id);
    return {
      accountType: row.account_type,
      createdAt: isoTime(row.created_at),
      email: row.email,
      hasPassword: row.has_password === 1,
      // The latest invite has the latest created_at, so "no password set
      // since ANY invite" (own_password false) is "none since this one".
      invite: invite === undefined ? null : { ...invite, pending: row.own_password !== 1 },
      memberships: memberships.get(row.user_id) ?? [],
      name: row.name,
      printMemberships: printMemberships.get(row.user_id) ?? [],
      status: row.status,
      userId: row.user_id,
    };
  });
}

/**
 * One page of the directory, ordered by user id (keyset pagination: the cursor
 * is the last id of the previous page). The id is the one ordering key whose
 * format this module controls end to end; `createdAt` is written by Better Auth
 * and by the importer, and a cursor built from it would depend on both agreeing
 * on a string format.
 *
 * `tenantId` keeps users with ANY membership in that shop — tenant or print,
 * active, suspended or revoked — so an operator can see who used to have access
 * as well as who has it now. `now` decides `invite.expired`.
 */
export async function listDirectoryUsers(
  db: D1Database,
  query: UserListQuery,
  now: number,
): Promise<{ nextCursor: string | null; users: DirectoryUser[] }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (query.accountType !== null) {
    where.push("a.account_type = ?");
    binds.push(query.accountType);
  }
  if (query.tenantId !== null) {
    where.push(`(
      EXISTS (SELECT 1 FROM tenant_memberships AS m
              WHERE m.user_id = u."id" AND m.tenant_id = ?)
      OR EXISTS (SELECT 1 FROM print_memberships AS p
                 WHERE p.user_id = u."id" AND p.tenant_id = ?)
    )`);
    binds.push(query.tenantId, query.tenantId);
  }
  if (query.cursor !== null) {
    where.push('u."id" > ?');
    binds.push(query.cursor);
  }

  const rows = await db
    .prepare(
      `SELECT ${USER_COLUMNS}
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY u."id"
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<UserRow>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);

  return {
    nextCursor:
      rows.results.length > query.limit && last !== undefined ? last.user_id : null,
    users: await attachDetails(db, page, now),
  };
}

/** One user's directory entry, or null when no such user exists. */
export async function getDirectoryUser(
  db: D1Database,
  userId: string,
  now: number,
): Promise<DirectoryUser | null> {
  const row = await db
    .prepare(
      `SELECT ${USER_COLUMNS}
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       WHERE u."id" = ?
       LIMIT 1`,
    )
    .bind(userId)
    .first<UserRow>();

  if (row === null) {
    return null;
  }

  const [user] = await attachDetails(db, [row], now);
  return user ?? null;
}
