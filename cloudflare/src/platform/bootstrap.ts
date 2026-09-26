import { createAuth, isAuthConfigured } from "../auth/create-auth";

export interface BootstrapInput {
  email: string;
  name: string;
  password: string;
}

export interface BootstrappedUser {
  email: string;
  userId: string;
}

export type BootstrapResult =
  | { status: "ok"; user: BootstrappedUser }
  | { status: "conflict" | "not_found" };

const BOOTSTRAP_KEYS = ["email", "name", "password"] as const;

const MINIMUM_TOKEN_LENGTH = 32;
const EMAIL_MAX_LENGTH = 254;
const NAME_MAX_LENGTH = 100;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

// Whitespace and C0/C1 control bytes are rejected outright rather than trimmed:
// an address that only becomes valid after normalization is a different address
// than the one the caller sent, and header-splitting bytes must never survive
// into a stored identity.
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
 * Deliberately looser than Better Auth's own address validation: this is a
 * shape gate, not an authority on deliverability. It only guarantees the value
 * is a single-@ address of bounded length with no whitespace or control bytes,
 * lowercased so the stored identity matches what a later sign-in sends.
 */
function parseEmail(value: unknown): string | null {
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

function parsePassword(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH
    ? value
    : null;
}

function parseName(value: unknown, email: string): string | null {
  if (value === undefined) {
    // The local part always exists: parseEmail has already established that
    // the address has exactly one '@' with a non-empty side on each end.
    return email.split("@")[0] as string;
  }

  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= NAME_MAX_LENGTH
    ? value
    : null;
}

export function parseBootstrapInput(body: unknown): BootstrapInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, BOOTSTRAP_KEYS)) {
    return null;
  }

  const email = parseEmail(body.email);
  const password = parsePassword(body.password);
  if (email === null || password === null) {
    return null;
  }

  const name = parseName(body.name, email);
  return name === null ? null : { email, name, password };
}

/**
 * crypto.subtle.timingSafeEqual is a Workers runtime extension. The tsconfig
 * "WebWorker" lib declares its own SubtleCrypto, which shadows the
 * workers-types declaration that carries this method, so the cast reaches a
 * method that genuinely exists at runtime rather than papering over a missing
 * one. Narrowed to the single method so nothing else escapes the type checker.
 */
const timingSafeEqual = (
  crypto.subtle as unknown as {
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  }
).timingSafeEqual.bind(crypto.subtle);

/**
 * Compares the presented token against the configured one without leaking
 * either its length or its content through timing. timingSafeEqual throws on
 * inputs of unequal length, so both sides are hashed to a fixed 32-byte
 * SHA-256 digest first: the digest length is constant regardless of input, so
 * even a one-character token is compared against a full-length buffer, and a
 * mismatch anywhere in the token produces an unrelated digest.
 */
export async function isMatchingBootstrapToken(
  presented: string,
  configured: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [presentedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);

  return timingSafeEqual(presentedDigest, configuredDigest);
}

export function isBootstrapConfigured(env: Env): boolean {
  return (
    isAuthConfigured(env) &&
    typeof env.BOOTSTRAP_TOKEN === "string" &&
    env.BOOTSTRAP_TOKEN.length >= MINIMUM_TOKEN_LENGTH
  );
}

async function hasPlatformAdmin(db: D1Database): Promise<boolean> {
  // Any status counts, not just 'active': a suspended or revoked platform
  // admin still means the bootstrap already happened, and re-running it would
  // hand an attacker a fresh admin beside the one an operator disabled.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM identity_access
       WHERE account_type = 'platform_admin'`,
    )
    .first<{ total: number }>();

  return (row?.total ?? 0) > 0;
}

/**
 * Authorizes a bootstrap attempt. Returns false for every failure mode so the
 * caller can answer with one indistinguishable 404: an unconfigured token, a
 * wrong token and an already-bootstrapped platform must look identical from
 * outside, or the route becomes an oracle for its own preconditions.
 */
export async function isBootstrapAllowed(
  env: Env,
  request: Request,
): Promise<boolean> {
  if (!isBootstrapConfigured(env)) {
    return false;
  }

  const presented = request.headers.get("x-bootstrap-token");
  if (presented === null) {
    return false;
  }

  if (
    !(await isMatchingBootstrapToken(presented, env.BOOTSTRAP_TOKEN as string))
  ) {
    return false;
  }

  return !(await hasPlatformAdmin(env.DB));
}

/**
 * Mints the first platform admin. The caller must have cleared
 * isBootstrapAllowed first — this function re-checks the zero-admin invariant
 * but never re-checks the token.
 *
 * TOCTOU: two concurrent bootstraps can both pass the zero-admin check and both
 * create a Better Auth user, but only one identity_access INSERT can win the
 * user_id primary key. The loser returns 409 and leaves behind an orphan user
 * with no access row at all. That orphan is harmless: it can sign in, but every
 * guard resolves its privileges from identity_access, so it holds none. It is
 * left in place deliberately rather than deleted, because deleting a user the
 * race may still be writing to is riskier than an inert row an operator can
 * remove by hand.
 */
export async function bootstrapPlatformAdmin(
  env: Env,
  input: BootstrapInput,
  now: number,
): Promise<BootstrapResult> {
  if (await hasPlatformAdmin(env.DB)) {
    return { status: "not_found" };
  }

  const signedUp = await createAuth(env).api.signUpEmail({
    body: {
      email: input.email,
      name: input.name,
      password: input.password,
    },
  });

  const userId = signedUp.user.id;

  if (await hasPlatformAdmin(env.DB)) {
    return { status: "conflict" };
  }

  try {
    await env.DB.batch([
      // Plain INSERT, never an upsert: user_id is the primary key, so a racing
      // bootstrap fails loudly here instead of overwriting an account kind.
      env.DB
        .prepare(
          `INSERT INTO identity_access (
            user_id, account_type, status, created_at, updated_at
          ) VALUES (?, 'platform_admin', 'active', ?, ?)`,
        )
        .bind(userId, now, now),
      // tenant_id stays NULL: the first platform admin belongs to no tenant.
      // metadata_json stays NULL too — the email is a personal identifier and
      // the user row already binds it to this resource id.
      env.DB
        .prepare(
          `INSERT INTO audit_events (
            event_id, tenant_id, actor_user_id, action, resource_type,
            resource_id, request_id, metadata_json, created_at
          ) VALUES (?, NULL, ?, 'platform.bootstrap', 'identity_access', ?, ?, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), userId, userId, crypto.randomUUID(), now),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return { status: "conflict" };
    }
    throw error;
  }

  return {
    status: "ok",
    user: { email: input.email, userId },
  };
}
