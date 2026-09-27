/**
 * scripts/cf-port/migrate/lib/transform-users.mjs — manifest row 62:
 * `users` (joined to the Auth export) → Better Auth `user` + `account`,
 * `identity_access`, `tenant_memberships`, `legacy_id_map`.
 *
 * Source of identity: the Auth record joined to `users/{uid}`; the Auth email
 * wins (D11/§a). An Auth user with no `users` document is not carried — the
 * caller counts these (report line, no names).
 *
 * D12: `role === 'print_shop'` is archived, not imported.
 * D51: platform admins ARE created by the importer (the only way they arrive).
 * New ids: deterministic from (env, legacy uid) — lib/ids.mjs — so a re-run
 * looks up the SAME id (idempotent; the importer does not re-derive from
 * legacy_id_map on a re-run within one process — it derives the same value
 * either way, which is the point of a deterministic function).
 *
 * No password is ever written: `account.password = NULL` (0002 allows a NULL
 * password column) — the migration-invite flow (CP3-B) is what lets a carried
 * user set one.
 *
 * Suspension (manifest §a, FAIL CLOSED): identity_access.status = 'suspended'
 * when `active !== true`, or `isActive !== true`, or the Auth record is
 * disabled, or there is no Auth record at all. A flag that is missing, null
 * or not a boolean suspends: an incomplete record never becomes an active
 * administrator.
 *
 * D59 adoption: with `--target-state`, a mapped email that ALREADY exists as
 * a user in the target adopts that existing user's id instead of minting a
 * new one (the legacy_id_map row then points the legacy uid at the existing
 * user, and no `user`/`account` INSERT is emitted for that identity).
 *
 * An adoption is REFUSED unless the identity in the target is what the import
 * would have written: the same account type and the same status. INSERT OR
 * IGNORE keeps the target's row, so without this check an imported platform
 * admin adopted onto a shop admin would stay a shop admin while the plan, the
 * report and the last-admin rule all said platform admin. When the target
 * user has an identity row, none is emitted; when it has none, the import's
 * row is written. A target state that says nothing about the adopted user's
 * authorization refuses too.
 */

import { createHash } from 'node:crypto';
import { insertStatement, sqlIdent, sqlLiteral } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { resolveEmail } from './scrub.mjs';
import { deterministicUserId } from './ids.mjs';
import { formatTime } from './time-columns.mjs';
import { parseSourceTimestampMillis } from './timestamps.mjs';

/** D12. */
export const ARCHIVED_USER_ROLES = new Set(['print_shop']);

/** A stand-in for a legacy uid in any message this tool prints (review round
 * 1, fix 4: no user id in terminal output) — the first 12 hex characters of
 * sha256(uid), so a reviewer holding the id map can still locate the row
 * without the uid itself ever reaching stdout/stderr/plan.json. */
export function uidFingerprint(uid) {
  return createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 12);
}

/** Joins the `users` collection docs to the Auth export by uid. Returns
 * { joined: [{ uid, userDoc, authUser }], authOnlyCount, mismatchedEmails }. */
export function joinUsersToAuth(userDocs, authUsers) {
  const authByUid = new Map(authUsers.map((u) => [u.uid, u]));
  const joined = [];
  const mismatchedEmails = [];
  const seenUids = {}; // uid -> true; a plain object, not a Set (the no-write-calls scan flags Set#add as a write-shaped call; nothing here ever touches Firestore)
  for (const doc of userDocs) {
    const uid = doc.id;
    seenUids[uid] = true;
    const authUser = authByUid.get(uid) ?? null;
    if (authUser && doc.data?.email && authUser.email && doc.data.email !== authUser.email) {
      mismatchedEmails.push({ authEmail: authUser.email, docEmail: doc.data.email, uid });
    }
    joined.push({ authUser, uid, userDoc: doc });
  }
  const authOnlyCount = authUsers.filter((u) => !Object.hasOwn(seenUids, u.uid)).length;
  return { authOnlyCount, joined, mismatchedEmails };
}

/**
 * Decides the account_type + membership for one joined user, per manifest §a.
 * Returns null when the user is not carried at all (D12, or no usable role).
 */
export function classifyUser(userDoc) {
  const data = userDoc.data ?? {};
  const role = data.role;
  if (ARCHIVED_USER_ROLES.has(role)) {
    return null; // D12
  }
  if (role === 'admin' && data.platform === true && (data.shopId === null || data.shopId === undefined)) {
    return { accountType: 'platform_admin', membership: null };
  }
  if (role === 'admin' && data.platform !== true && typeof data.shopId === 'string' && data.shopId.length > 0) {
    return { accountType: 'tenant_admin', membership: { role: 'admin', tenantId: data.shopId } };
  }
  return null; // "anything else → not carried"
}

/**
 * Transforms one joined (users doc + Auth record) pair. Returns
 *   { carried: boolean, reason: string|null, rows: [...], report: {...} }
 * `env`, `nowMillis`, `emailMap`, `scrubUnmapped` as elsewhere. `targetState` is
 * the optional { emails: Map<lowercaseEmail, existingUserId> } read from
 * --target-state (D59 adoption); may be null (assume empty target).
 *
 * `knownTenantIds` (review round 1, fix 6): a Set of tenant ids this plan
 * imports PLUS the tenant ids already in --target-state. A tenant-admin user
 * whose own shop is in neither (archived by D21, or simply missing from the
 * bundle) is still carried — the account and identity_access rows are
 * written as usual — but its `tenant_memberships` row is SKIPPED (never
 * written pointing at a shop that will not exist, which would violate the
 * table's own tenant_id foreign key and abort the apply) and the omission is
 * counted in the report rather than silently dropped.
 */
export function transformUser({ authUser, emailMap, env, knownTenantIds = null, nowMillis, scrubUnmapped, targetState, uid, userDoc }) {
  const classification = classifyUser(userDoc);
  if (classification === null) {
    return { carried: false, reason: 'not a carried role (D12 print_shop, or role/platform/shopId combination not carried)', rows: [], uid };
  }

  const data = userDoc.data ?? {};
  const sourceEmail = authUser?.email ?? data.email ?? null;
  if (typeof sourceEmail !== 'string' || sourceEmail.length === 0) {
    return { carried: false, reason: 'no usable email (neither Auth record nor users doc carries one)', rows: [], uid };
  }
  // The `where` names the collection and a fingerprint of the uid, never the
  // uid itself (review round 1, fix 4: no user id in terminal output).
  const resolvedEmail = resolveEmail(sourceEmail, emailMap, scrubUnmapped, `users/<uid ${uidFingerprint(uid)}>.email`);
  const email = resolvedEmail.value;

  const emailLower = email.toLowerCase();
  const adopted = targetState?.emails?.get(emailLower) ?? null;
  const newUserId = adopted ?? deterministicUserId(env, uid);

  const name = (typeof data.contactPerson === 'string' && data.contactPerson.trim().length > 0
    ? data.contactPerson.trim()
    : typeof authUser?.displayName === 'string' && authUser.displayName.trim().length > 0
      ? authUser.displayName.trim()
      : email.split('@')[0]) || email;

  const emailVerified = authUser?.emailVerified === true ? 1 : 0;
  const createdAtMillisSource = parseSourceTimestampMillis(data.createdAt, null);
  const createdAtMillis = createdAtMillisSource ?? parseSourceTimestampMillis(authUser?.metadata?.creationTime, nowMillis);

  const suspended = data.active !== true || data.isActive !== true || authUser === null || authUser === undefined || authUser.disabled !== false;
  const status = suspended ? 'suspended' : 'active';

  // An adoption must leave the target as the import describes it.
  let existingIdentity = null;
  if (adopted !== null) {
    const known = targetState?.identities instanceof Map ? targetState.identities.get(adopted) : undefined;
    const where = `users/<uid ${uidFingerprint(uid)}>`;
    if (known === undefined) {
      return { carried: false, reason: 'adoption refused', refusal: `${where}: the address exists in the target, and the target state says nothing about that user's authorization (rebuild it with state-from-queries.mjs)`, rows: [], uid };
    }
    if (known !== null && (known.accountType !== classification.accountType || known.status !== status)) {
      return {
        carried: false,
        reason: 'adoption refused',
        refusal: `${where}: the address exists in the target as ${known.accountType}/${known.status}, the import carries ${classification.accountType}/${status}; the target's row would stay as it is`,
        rows: [],
        uid,
      };
    }
    existingIdentity = known;
  }

  const rows = [];
  const report = { accountType: classification.accountType, adopted: adopted !== null, emailAction: resolvedEmail.action, newUserId, suspended, uid };

  // legacy_id_map — always written (append-only, INSERT OR IGNORE is safe on
  // a re-run because the SAME (env, uid) always derives the SAME newUserId).
  // legacy_id_map.created_at is TEXT ISO (0033).
  const mapRow = { created_at: formatTime('legacy_id_map', 'created_at', nowMillis), env, kind: 'user', legacy_id: uid, new_id: newUserId };
  const mapColumns = ['kind', 'legacy_id', 'new_id', 'env', 'created_at'];
  rows.push(carriedRow('legacy_id_map', `user:${uid}`, insertStatement('legacy_id_map', mapColumns, mapRow), rowContentHash('legacy_id_map', mapColumns, mapRow)));

  // Better Auth's "user"/"account" DATE columns store ISO TEXT on this D1
  // adapter (confirmed read-only against staging, review round 1 fix 1).
  const userCreatedAt = formatTime('user', 'createdAt', createdAtMillis);
  const userUpdatedAt = formatTime('user', 'updatedAt', nowMillis);
  if (adopted === null) {
    // `user` (Better Auth) — camelCase columns need identifier quoting.
    const userColumns = ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'];
    const userStatement = `INSERT OR IGNORE INTO "user" (${userColumns.map(sqlIdent).join(', ')}) VALUES (${[
      sqlLiteral(newUserId),
      sqlLiteral(name),
      sqlLiteral(email),
      sqlLiteral(emailVerified),
      sqlLiteral(null),
      sqlLiteral(userCreatedAt),
      sqlLiteral(userUpdatedAt),
    ].join(', ')});`;
    const userRowForHash = { createdAt: userCreatedAt, email, emailVerified, id: newUserId, image: null, name, updatedAt: userUpdatedAt };
    rows.push(carriedRow('user', newUserId, userStatement, rowContentHash('user', userColumns, userRowForHash)));

    // `account` — credential provider, NULL password (forced reset flow).
    const accountId = `acct_${newUserId}`;
    const accountColumns = [
      'id',
      'accountId',
      'providerId',
      'userId',
      'accessToken',
      'refreshToken',
      'idToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
      'scope',
      'password',
      'createdAt',
      'updatedAt',
    ];
    const accountRow = {
      accessToken: null,
      accessTokenExpiresAt: null,
      accountId: newUserId,
      createdAt: formatTime('account', 'createdAt', createdAtMillis),
      id: accountId,
      idToken: null,
      password: null,
      providerId: 'credential',
      refreshToken: null,
      refreshTokenExpiresAt: null,
      scope: null,
      updatedAt: formatTime('account', 'updatedAt', nowMillis),
      userId: newUserId,
    };
    const accountStatement = `INSERT OR IGNORE INTO "account" (${accountColumns.map(sqlIdent).join(', ')}) VALUES (${accountColumns
      .map((c) => sqlLiteral(accountRow[c]))
      .join(', ')});`;
    rows.push(carriedRow('account', accountId, accountStatement, rowContentHash('account', accountColumns, accountRow)));
  }

  // identity_access — created_at/updated_at are INTEGER milliseconds (0002).
  // Not written for an adopted user that has its row: the row is the target's.
  if (existingIdentity === null) {
    const identityColumns = ['user_id', 'account_type', 'status', 'created_at', 'updated_at'];
    const identityRow = {
      account_type: classification.accountType,
      created_at: formatTime('identity_access', 'created_at', createdAtMillis),
      status,
      updated_at: formatTime('identity_access', 'updated_at', nowMillis),
      user_id: newUserId,
    };
    rows.push(
      carriedRow('identity_access', newUserId, insertStatement('identity_access', identityColumns, identityRow), rowContentHash('identity_access', identityColumns, identityRow)),
    );
  }

  // tenant_memberships (tenant_admin only) — created_at/updated_at are
  // INTEGER milliseconds (0002), same as identity_access.
  let membershipSkippedUnknownTenant = false;
  if (classification.membership) {
    const tenantId = classification.membership.tenantId;
    const tenantKnown = knownTenantIds === null || knownTenantIds.has(tenantId);
    if (!tenantKnown) {
      // Fix 6: the user's own shop is neither in this plan (archived by D21,
      // or absent from the bundle) nor already in the target — writing the
      // membership would point tenant_memberships.tenant_id at a shop that
      // will not exist, violating its foreign key and aborting the whole
      // apply. The user is still carried (account + identity_access above);
      // only the membership is skipped, and the omission is counted.
      membershipSkippedUnknownTenant = true;
    } else {
      const membershipId = `mem_${newUserId}_${tenantId}_admin`;
      const membershipColumns = ['membership_id', 'tenant_id', 'user_id', 'role', 'status', 'created_at', 'updated_at'];
      const membershipRow = {
        created_at: formatTime('tenant_memberships', 'created_at', createdAtMillis),
        membership_id: membershipId,
        role: 'admin',
        status: suspended ? 'suspended' : 'active',
        tenant_id: tenantId,
        updated_at: formatTime('tenant_memberships', 'updated_at', nowMillis),
        user_id: newUserId,
      };
      rows.push(
        carriedRow(
          'tenant_memberships',
          membershipId,
          insertStatement('tenant_memberships', membershipColumns, membershipRow),
          rowContentHash('tenant_memberships', membershipColumns, membershipRow),
        ),
      );
    }
  }

  report.membershipSkippedUnknownTenant = membershipSkippedUnknownTenant;
  return { carried: true, reason: null, report, rows, uid };
}

/** The "at least one active platform admin" refusal (manifest §a / C-rules).
 * Called by import.mjs after every user has been classified, counting BOTH
 * the carried rows and (if given) the target state's existing active
 * platform admins. */
export function hasActivePlatformAdminAfterImport(transformedUsers, targetActivePlatformAdminCount = 0) {
  const carriedActive = transformedUsers.some(
    (u) => u.carried && u.report?.accountType === 'platform_admin' && !u.report?.suspended,
  );
  return carriedActive || targetActivePlatformAdminCount > 0;
}
