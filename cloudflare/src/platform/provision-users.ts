import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";

import type { PlatformPrincipal, TenantAdminPrincipal } from "../auth/live-authorization";
import { createAuth } from "../auth/create-auth";
import { inviteSurfaceFor } from "./invites";

/**
 * Platform-operator user provisioning.
 *
 * WHY THIS EXISTS
 * ---------------
 * Public sign-up is closed by design (see auth-routes: the /api/auth/* allowlist
 * admits sign-in, sign-out and get-session, and nothing else). Accounts arrive
 * through provisioning instead. The bootstrap route mints exactly one identity —
 * the first platform admin — and then goes permanently dead, and the tenant-admin
 * grant route takes an ALREADY EXISTING userId. Between those two facts there was
 * no HTTP path to create any further user at all, so a tenant admin could not be
 * brought into being in a live environment. This route is that missing surface.
 *
 * CREDENTIAL MODEL: AN INVITED IDENTITY HAS NO PASSWORD
 * ----------------------------------------------------
 * Without `password` (the console's way, and the shop's own invite in
 * tenant-members.ts) the identity is created WITHOUT a password and the person
 * sets their own from the invite's link (invites.ts). It is written in ONE
 * batch — the user, its credential account with a NULL password, the
 * identity_access row and the audit row — so from the first moment any reader
 * can see the user, it is complete and password-less: no reader can ever take
 * a password nobody chose for one the person set (the directory's
 * `hasPassword`, the shop's `invited`, the invite decision of
 * tenant-members.ts). This is exactly the shape the importer writes for a
 * carried admin (MIGRATION_MANIFEST §a). Better Auth refuses a sign-in to it
 * whatever the password, and its reset endpoint sets the password on that
 * account when the invite's link is used.
 *
 * With `password` (the interim model, kept for the staging scripts that sign
 * in as the identity they create) the operator chooses the initial password
 * and communicates it out of band; Better Auth's sign-up writes it. Password
 * reset and password change are separate checkpoints and are NOT part of this
 * surface.
 *
 * THE PLATFORM_ADMIN FLOOR
 * ------------------------
 * `accountType` accepts 'tenant_admin' and 'print_operator' only. Platform
 * admins are deliberately NOT creatable over HTTP: a stolen or hijacked platform
 * session must not be able to mint more of itself. Today the blast radius of a
 * compromised platform session is bounded by what an operator can undo — this
 * route could otherwise let an attacker manufacture a fleet of persistent
 * co-equal admins that survive revoking the original. Platform admins therefore
 * come from bootstrap (once) or from a deliberate operator action against the
 * database. Raising this floor requires its own checkpoint with its own
 * second-factor story, not an extra string in this array.
 *
 * 'ordinary' is excluded for a duller reason: nothing needs it yet. Customer
 * identities are created by the storefront's own flows when those land, and an
 * unused branch here is one more thing to keep correct.
 *
 * RATE LIMITING
 * -------------
 * None, matching every other platform surface. The durable limiter added in
 * checkpoint 19 guards ANONYMOUS surfaces — checkout, which anyone can reach,
 * and bootstrap, whose header token is brute-forceable. This route is behind a
 * live platform session that must already exist in D1, so there is no
 * unauthenticated caller to throttle: reaching it at all means the attacker has
 * already won a platform session, at which point a request limiter is not the
 * control that matters. If a future checkpoint wants abuse accounting for
 * authenticated operators, that is an audit-trail question (the rows this route
 * writes) rather than a limiter question.
 */

export type ProvisionableAccountType = "print_operator" | "tenant_admin";

export interface CreateUserInput {
  accountType: ProvisionableAccountType;
  email: string;
  /** null: created without a password (see "CREDENTIAL MODEL" above). */
  password: string | null;
}

export interface CreateInvitedUserInput {
  accountType: ProvisionableAccountType;
  email: string;
  name: string;
}

export interface ProvisionedUser {
  accountType: ProvisionableAccountType;
  email: string;
  userId: string;
}

export type CreateUserResult =
  | { status: "conflict" | "invalid" }
  | { status: "ok"; user: ProvisionedUser };

const CREATE_USER_KEYS = ["accountType", "email", "password"] as const;

// Deliberately NOT the full identity_access CHECK list. 'platform_admin' and
// 'ordinary' are excluded on purpose; see the module comment above before
// adding to this array.
const PROVISIONABLE_ACCOUNT_TYPES: readonly ProvisionableAccountType[] = [
  "print_operator",
  "tenant_admin",
];

const EMAIL_MAX_LENGTH = 254;

// Same rule the checkout parser and the bootstrap parser apply: whitespace and
// C0/C1 control bytes are rejected outright rather than trimmed away. An address
// that only becomes valid after normalization is a different address than the
// one the caller sent, and header-splitting bytes must never reach a stored
// identity.
const EMAIL_FORBIDDEN_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

/**
 * A shape gate, not an authority on deliverability — identical in rule to the
 * bootstrap and checkout parsers so one address cannot be accepted by one
 * surface and refused by another. Guarantees a single-'@' address of bounded
 * length with no whitespace or control bytes, lowercased so the stored identity
 * matches what a later sign-in sends.
 */
export function parseEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > EMAIL_MAX_LENGTH) {
    return null;
  }

  const email = value.toLowerCase();
  if (EMAIL_FORBIDDEN_PATTERN.test(email)) {
    return null;
  }

  const [local, domain, ...rest] = email.split("@");
  if (rest.length > 0 || local === undefined || domain === undefined) {
    return null;
  }

  return local.length > 0 && domain.length > 0 ? email : null;
}

function parseAccountType(value: unknown): ProvisionableAccountType | null {
  return typeof value === "string" &&
    (PROVISIONABLE_ACCOUNT_TYPES as readonly string[]).includes(value)
    ? (value as ProvisionableAccountType)
    : null;
}

/**
 * The password is checked for type only. Better Auth owns the password POLICY
 * (currently a minimum of 8 and a maximum of 128 characters, probed against the
 * pinned 1.6.29 rather than assumed), and duplicating those bounds here would
 * create two authorities that drift apart the moment the library's defaults or
 * this application's configuration change. A policy rejection comes back as an
 * APIError and is mapped to the same opaque 400 as any other invalid body.
 */
function parsePassword(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `{ accountType, email }` creates an identity without a password;
 * `{ accountType, email, password }` one with that password. A `password` key
 * that is present must be a non-empty string: `null` or `""` is refused, never
 * read as "no password". Only an invitable kind (invites.ts inviteSurfaceFor:
 * of the creatable ones, `tenant_admin`) may be created without a password —
 * nothing could ever give a password-less print operator one.
 */
export function parseCreateUserInput(body: unknown): CreateUserInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, CREATE_USER_KEYS)) {
    return null;
  }

  const accountType = parseAccountType(body.accountType);
  const email = parseEmail(body.email);
  const password = "password" in body ? parsePassword(body.password) : null;
  if (accountType === null || email === null) {
    return null;
  }
  if ("password" in body ? password === null : inviteSurfaceFor(accountType) === null) {
    return null;
  }

  return { accountType, email, password };
}

/**
 * Better Auth signals every failure as a thrown error carrying a `body.code`
 * string. That code is the discriminator, NOT the error class: probing the
 * pinned 1.6.29 showed `error instanceof APIError` is true for the duplicate and
 * password-policy branches but FALSE for the validation branch, which throws an
 * APIError-shaped error from a different module instance. Matching on the class
 * would therefore silently misroute exactly one branch.
 *
 * Observed codes: USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL (422),
 * PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG (400), VALIDATION_ERROR (400).
 */
function authErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") {
    return null;
  }

  const body = (error as { body?: unknown }).body;
  if (!isPlainObject(body)) {
    return null;
  }

  return typeof body.code === "string" ? body.code : null;
}

const DUPLICATE_EMAIL_CODE = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";

// Every remaining code Better Auth can raise for a well-formed call is a
// statement about the credential the operator supplied, so all of them collapse
// into the same opaque 400. Listing them explicitly rather than treating "any
// error" as a 400 keeps a genuine infrastructure failure (a D1 outage mid
// sign-up, say) escalating as a 500 instead of being reported to the operator as
// their own bad input.
const INPUT_REJECTION_CODES: ReadonlySet<string> = new Set([
  "PASSWORD_TOO_LONG",
  "PASSWORD_TOO_SHORT",
  "VALIDATION_ERROR",
]);

/**
 * Creates a platform-provisioned user and its identity_access row.
 *
 * The flow mirrors bootstrap's proven pattern: the Better Auth server API mints
 * the user (bypassing the mounted-surface allowlist exactly as bootstrap does —
 * api.signUpEmail is called directly, so the fact that POST /api/auth/sign-up/email
 * is a 404 over HTTP is irrelevant here), then one db.batch writes the access
 * row and its audit row together.
 *
 * TOCTOU / racing duplicates: three layers, because under this application's
 * autoSignIn:false configuration Better Auth SWALLOWS a duplicate sign-up
 * rather than throwing (see the pre-check comment inside). The pre-check
 * converts the common duplicate to a clean 409; the persistence check catches a
 * race that slipped past it before the phantom id can fail a FOREIGN KEY; and
 * the identity_access primary key makes two racing writers for one real userId
 * fail loudly, with the loser answering 409. The thrown DUPLICATE_EMAIL_CODE
 * branch remains as defence in depth for an upgrade that restores the throwing
 * behaviour. A race's orphan user is privilege-less by construction — it can
 * sign in, but every guard resolves privileges from identity_access and it
 * holds no row there — and is left in place deliberately, the same documented
 * posture as bootstrap: deleting a user that a race may still be writing to is
 * riskier than an inert row an operator can remove by hand.
 *
 * No session is created or returned. The new user signs in through the normal
 * mounted sign-in route.
 *
 * Without a password the call is createInvitedUser's, the name being the
 * address's local part as on the password path.
 */
export async function createPlatformUser(
  env: Env,
  principal: PlatformPrincipal | TenantAdminPrincipal,
  input: CreateUserInput,
  now: number,
): Promise<CreateUserResult> {
  if (input.password === null) {
    return createInvitedUser(
      env,
      principal,
      {
        accountType: input.accountType,
        email: input.email,
        name: localPartOf(input.email),
      },
      now,
    );
  }

  let userId: string;

  // Better Auth does NOT reliably refuse a duplicate here, so the address is
  // checked first. With autoSignIn disabled (which this application sets, so
  // provisioning never mints an orphan session) signUpEmail answers a duplicate
  // SUCCESSFULLY, returning a fabricated user id that was never persisted —
  // probed against the pinned 1.6.29: two calls for one address yield two
  // different ids, only the first of which exists as a row. That is sound
  // enumeration-hardening for a public sign-up, which must not disclose whether
  // an address is registered, but for a server-side provisioning caller it means
  // the thrown-conflict branch below cannot be relied on alone: without this
  // pre-check the phantom id flows into the identity_access INSERT and fails a
  // FOREIGN KEY, turning an ordinary duplicate into a 500.
  //
  // This read is not a TOCTOU guarantee and is not meant to be one. It converts
  // the COMMON case into a clean 409; a genuine race is still caught downstream
  // by the primary key and the persistence check, both of which stay in place.
  const existing = await env.DB
    .prepare('SELECT "id" FROM "user" WHERE "email" = ? LIMIT 1')
    .bind(input.email)
    .first<{ id: string }>();

  if (existing !== null) {
    return { status: "conflict" };
  }

  try {
    const signedUp = await createAuth(env).api.signUpEmail({
      body: {
        email: input.email,
        name: localPartOf(input.email),
        password: input.password,
      },
    });

    userId = signedUp.user.id;
  } catch (error) {
    const code = authErrorCode(error);

    // A bare conflict either way. Which HALF already existed — the Better Auth
    // user or an identity_access row of some other kind — is exactly what
    // checkpoint 13's one-kind boundary refuses to disclose, and the same
    // reticence applies here: an operator learns "this email is taken", never
    // what it is taken by.
    if (code === DUPLICATE_EMAIL_CODE) {
      return { status: "conflict" };
    }
    if (code !== null && INPUT_REJECTION_CODES.has(code)) {
      return { status: "invalid" };
    }

    throw error;
  }

  // The id must correspond to a row that actually exists before it is used as a
  // foreign key. Under the swallowed-duplicate behaviour described above, a
  // racing provision that slipped past the pre-check would otherwise carry a
  // fabricated id into the batch and fail a FOREIGN KEY as a 500; here it
  // becomes the same bare 409 as any other duplicate.
  const persisted = await env.DB
    .prepare('SELECT "id" FROM "user" WHERE "id" = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string }>();

  if (persisted === null) {
    return { status: "conflict" };
  }

  try {
    await env.DB.batch(
      accessStatements(env.DB, principal, userId, input.accountType, now),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    status: "ok",
    user: {
      accountType: input.accountType,
      email: input.email,
      userId,
    },
  };
}

/**
 * The local part, never a caller-supplied display name on the HTTP surface:
 * it provisions a credential, and a name is profile data the user owns.
 * parseEmail has already established exactly one '@' with a non-empty side on
 * each end, so the split always yields a local part.
 */
function localPartOf(email: string): string {
  return email.split("@")[0] as string;
}

/**
 * Whether Better Auth's sign-in and sign-up accept the address: the same
 * check they run (`z.email()` of the zod they use). parseEmail is a looser
 * shape gate; `a..b@example.com` or `admin@localhost` pass it and are refused
 * at every sign-in.
 */
export function isSignInEmail(email: string): boolean {
  return z.email().safeParse(email).success;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

/** Better Auth's default id: 32 characters of [a-zA-Z0-9] (@better-auth/core generateId). */
function newAuthId(): string {
  return generateRandomString(32, "a-z", "A-Z", "0-9");
}

/** The identity_access row and its audit row, for both creation paths. */
function accessStatements(
  db: D1Database,
  principal: PlatformPrincipal | TenantAdminPrincipal,
  userId: string,
  accountType: ProvisionableAccountType,
  now: number,
): D1PreparedStatement[] {
  return [
    // Plain INSERT, never an upsert: user_id is the primary key, so a racing
    // provision fails loudly here instead of overwriting an account kind that
    // was decided somewhere else. This is also what enforces the one-kind
    // boundary against a second create for an identity that already holds a
    // different kind.
    db
      .prepare(
        `INSERT INTO identity_access (
          user_id, account_type, status, created_at, updated_at
        ) VALUES (?, ?, 'active', ?, ?)`,
      )
      .bind(userId, accountType, now, now),
    // tenant_id stays NULL: this route creates an identity, not a membership.
    // A tenant admin is bound to its tenant by the separate admins-grant
    // route, and a print operator by its own assignment.
    //
    // metadata_json carries the account type and NOTHING else — never the
    // email. The audit trail records what kind of privilege was manufactured,
    // which is the security-relevant fact; the address is a personal
    // identifier the "user" row already binds to this resource id.
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, request_id, metadata_json, created_at
        ) VALUES (?, NULL, ?, 'platform.user_provision', 'identity_access', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        userId,
        crypto.randomUUID(),
        JSON.stringify({ accountType }),
        now,
      ),
  ];
}

/**
 * Creates an identity WITHOUT a password, in ONE batch (a D1 batch is one
 * transaction): the Better Auth user, its credential account with a NULL
 * password, the identity_access row and the `platform.user_provision` audit
 * row. Nothing of it is visible before all of it is, so no concurrent reader
 * ever sees the user without its kind, nor any password on it. The person sets
 * a password through the invite's link (Better Auth's reset endpoint fills the
 * NULL); until then every sign-in is refused.
 *
 * The rows are the ones Better Auth's sign-up writes for this application
 * (the same columns, ISO-8601 times, `emailVerified` 0, `accountId` = the user
 * id), minus the password — exactly the importer's shape for a carried admin.
 * Written here rather than through Better Auth's adapter, because the adapter
 * writes the user and the account as separate statements, and the access row
 * must be in the same transaction as both.
 *
 * Duplicates: the address is checked first (the common case, a clean
 * conflict); a racing duplicate fails the batch on "user"."email" UNIQUE and
 * is the same conflict, leaving nothing behind.
 *
 * The address must be one Better Auth's sign-in accepts (isSignInEmail): the
 * password path gets that check from the sign-up; this path writes the rows
 * itself, and an identity whose address the sign-in refuses could never be
 * used. Refused as `invalid`, with nothing written.
 */
export async function createInvitedUser(
  env: Env,
  principal: PlatformPrincipal | TenantAdminPrincipal,
  input: CreateInvitedUserInput,
  now: number,
): Promise<CreateUserResult> {
  if (!isSignInEmail(input.email)) {
    return { status: "invalid" };
  }

  const existing = await env.DB
    .prepare('SELECT "id" FROM "user" WHERE "email" = ? LIMIT 1')
    .bind(input.email)
    .first<{ id: string }>();
  if (existing !== null) {
    return { status: "conflict" };
  }

  const userId = newAuthId();
  const iso = new Date(now).toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO "user" (
            "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
          ) VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        )
        .bind(userId, input.name, input.email, iso, iso),
      env.DB
        .prepare(
          `INSERT INTO "account" (
            "id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt"
          ) VALUES (?, ?, 'credential', ?, NULL, ?, ?)`,
        )
        .bind(newAuthId(), userId, userId, iso, iso),
      ...accessStatements(env.DB, principal, userId, input.accountType, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    status: "ok",
    user: { accountType: input.accountType, email: input.email, userId },
  };
}
