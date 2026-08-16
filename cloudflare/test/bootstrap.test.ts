import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const TOKEN = "test-only-bootstrap-token-at-least-32-characters";
const EMAIL = "founder@bootstrap.test";
// Submitted mixed-case on purpose: the route must lowercase the address so the
// stored identity matches what a later sign-in sends.
const SUBMITTED_EMAIL = "Founder@Bootstrap.TEST";
const PASSWORD = "bootstrap-password-long-enough";

interface BootstrapBody {
  user: {
    email: string;
    userId: string;
  };
}

function withEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides };
}

let ipCounter = 0;

/**
 * A distinct client address per request unless the caller pins one. The route
 * is rate limited to five attempts per IP per ten minutes, and this file makes
 * far more than that; without a fresh address each test after the fifth would
 * see the limiter's 404 rather than the guard it means to exercise. The limit
 * itself is pinned deliberately in the suite at the end of this file.
 */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 256}:${ipCounter}`;
}

function bootstrapRequest(
  options: { body?: unknown; ip?: string; token?: string | null } = {},
): Request {
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) {
    headers.set("x-bootstrap-token", token);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  headers.set("cf-connecting-ip", options.ip ?? nextIp());

  return new Request(`${AUTH_ORIGIN}/v1/platform/bootstrap`, {
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
    headers,
    method: "POST",
  });
}

async function bootstrap(
  options: {
    body?: unknown;
    ip?: string;
    overrides?: Partial<Env>;
    token?: string | null;
  } = {},
): Promise<Response> {
  const body =
    options.body === undefined
      ? { email: EMAIL, password: PASSWORD }
      : options.body;

  return worker.fetch(
    bootstrapRequest({ body, ip: options.ip, token: options.token }),
    options.overrides === undefined ? env : withEnv(options.overrides),
  );
}

async function countUsers(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM "user"',
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function accessRow(
  userId: string,
): Promise<{ account_type: string; status: string } | null> {
  return env.DB.prepare(
    "SELECT account_type, status FROM identity_access WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ account_type: string; status: string }>();
}

async function seedPlatformAdmin(status: string): Promise<string> {
  const userId = `seeded-admin-${status}`;
  const now = 1_787_400_000_000;

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .bind(userId, userId, `${userId}@bootstrap.test`, now, now),
    env.DB
      .prepare(
        `INSERT INTO identity_access (
          user_id, account_type, status, created_at, updated_at
        ) VALUES (?, 'platform_admin', ?, ?, ?)`,
      )
      .bind(userId, status, now, now),
  ]);

  return userId;
}

async function removeSeededAdmin(userId: string): Promise<void> {
  // The access row must go first: identity_access references "user" with
  // ON DELETE RESTRICT.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM identity_access WHERE user_id = ?").bind(userId),
    env.DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(userId),
  ]);
}

// The bootstrap route is one-shot by design and this file owns an isolated
// database, so the tests are ordered deliberately: everything that must run
// against a zero-admin platform runs before the successful bootstrap, and the
// suites after it rely on the admin it created.
describe("platform bootstrap guards before any admin exists", () => {
  it.each([
    ["missing header", null],
    ["wrong token", "completely-different-token-of-sufficient-length"],
    [
      "correct prefix, wrong suffix",
      "test-only-bootstrap-token-at-least-32-characterX",
    ],
    ["token prefix only", "test-only-bootstrap-token"],
    ["empty token", ""],
  ])("returns fail-closed 404 for %s", async (_label, token) => {
    const before = await countUsers();
    const response = await bootstrap({ token });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
    await expect(countUsers()).resolves.toBe(before);
  });

  it.each([
    ["an unset bootstrap token", { BOOTSTRAP_TOKEN: undefined }],
    ["a short bootstrap token", { BOOTSTRAP_TOKEN: "too-short-token" }],
    ["an unset auth secret", { BETTER_AUTH_SECRET: undefined }],
  ])("returns fail-closed 404 with %s", async (_label, overrides) => {
    const before = await countUsers();
    const response = await bootstrap({ overrides });

    expect(response.status).toBe(404);
    await expect(countUsers()).resolves.toBe(before);
  });

  it("returns 404 for a short configured token even when the header matches it", async () => {
    const before = await countUsers();
    const response = await bootstrap({
      overrides: { BOOTSTRAP_TOKEN: "short-token" },
      token: "short-token",
    });

    expect(response.status).toBe(404);
    await expect(countUsers()).resolves.toBe(before);
  });

  it.each([["GET"], ["PATCH"], ["DELETE"]])(
    "does not expose the route through %s",
    async (method) => {
      const response = await worker.fetch(
        new Request(`${AUTH_ORIGIN}/v1/platform/bootstrap`, {
          headers: { "x-bootstrap-token": TOKEN },
          method,
        }),
        env,
      );

      expect(response.status).toBe(404);
    },
  );

  it("hides a bad body behind the 404 when the token is wrong", async () => {
    const response = await bootstrap({
      body: { email: "not-an-email", password: "short" },
      token: "completely-different-token-of-sufficient-length",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it.each([
    ["missing email", { password: PASSWORD }],
    ["missing password", { email: EMAIL }],
    ["non-string email", { email: 42, password: PASSWORD }],
    ["email without @", { email: "nobody.bootstrap.test", password: PASSWORD }],
    ["email with two @", { email: "a@b@bootstrap.test", password: PASSWORD }],
    ["email with a space", { email: "a b@bootstrap.test", password: PASSWORD }],
    ["empty local part", { email: "@bootstrap.test", password: PASSWORD }],
    ["empty domain", { email: "nobody@", password: PASSWORD }],
    [
      "overlong email",
      { email: `${"e".repeat(250)}@bootstrap.test`, password: PASSWORD },
    ],
    ["short password", { email: EMAIL, password: "eleven-chr" }],
    ["overlong password", { email: EMAIL, password: "p".repeat(129) }],
    ["empty name", { email: EMAIL, name: "", password: PASSWORD }],
    [
      "overlong name",
      { email: EMAIL, name: "n".repeat(101), password: PASSWORD },
    ],
    [
      "unknown key",
      { email: EMAIL, password: PASSWORD, platformAdmin: true },
    ],
    ["array body", []],
    ["null body", null],
  ])("returns 400 for %s once the token is correct", async (_label, body) => {
    const before = await countUsers();
    const response = await bootstrap({ body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    await expect(countUsers()).resolves.toBe(before);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await bootstrap({ body: "{not json" });

    expect(response.status).toBe(400);
    await expect(countUsers()).resolves.toBe(0);
  });

  it.each([["active"], ["suspended"], ["revoked"]])(
    "returns 404 when a %s platform admin already exists",
    async (status) => {
      const seeded = await seedPlatformAdmin(status);
      const before = await countUsers();

      const response = await bootstrap();

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "not_found" },
      });
      await expect(countUsers()).resolves.toBe(before);

      // Undo the seed completely — access row and user row — so the ordered
      // suites below still start from a genuinely empty platform.
      await removeSeededAdmin(seeded);
    },
  );
});

describe("platform bootstrap rate limiting", () => {
  it("hides the limit behind the same 404, never a 429", async () => {
    const ip = "203.0.113.240";
    const wrongToken = "completely-different-token-of-sufficient-length";
    const before = await countUsers();

    // Five attempts are allowed through to the token compare, which refuses
    // them on their own merits.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const rejected = await bootstrap({ ip, token: wrongToken });

      expect(rejected.status).toBe(404);
    }

    // The sixth never reaches the compare. The status, body and headers must be
    // byte-identical to the five before it: a 429, a Retry-After, or a
    // different message would tell an attacker the surface is real and worth
    // continuing against, which is exactly what the uniform 404 exists to deny.
    const throttled = await bootstrap({ ip, token: wrongToken });

    expect(throttled.status).toBe(404);
    await expect(throttled.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
    expect(throttled.headers.get("retry-after")).toBeNull();

    // A CORRECT token is refused just the same once the address is throttled,
    // so the limiter cannot be used to distinguish a good token from a bad one.
    const throttledWithGoodToken = await bootstrap({ ip });

    expect(throttledWithGoodToken.status).toBe(404);
    await expect(throttledWithGoodToken.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });

    // And nothing was created along the way — the platform still has no admin,
    // which the ordered suites below depend on.
    await expect(countUsers()).resolves.toBe(before);
  });

  it("does not throttle an unrelated address", async () => {
    const response = await bootstrap({
      ip: "203.0.113.241",
      token: "completely-different-token-of-sufficient-length",
    });

    // Same 404 either way, so the assertion that matters is the counter: this
    // address must still have its own untouched allowance.
    expect(response.status).toBe(404);

    const windows = await env.DB.prepare(
      "SELECT count FROM rate_limit_windows WHERE scope = 'bootstrap-ip' ORDER BY count DESC",
    ).all<{ count: number }>();

    expect(windows.results.some((row) => row.count === 1)).toBe(true);
  });
});

describe("platform bootstrap happy path", () => {
  it("mints the first platform admin, who can then sign in and provision", async () => {
    await expect(countUsers()).resolves.toBe(0);

    const response = await bootstrap({
      body: { email: SUBMITTED_EMAIL, password: PASSWORD },
    });
    const body = await response.json<BootstrapBody>();

    expect(response.status).toBe(201);
    // Lowercased on the way in, so the identity that comes back — and the one
    // stored — is the canonical form, not the mixed case that was submitted.
    expect(body).toEqual({
      user: {
        email: EMAIL,
        userId: expect.any(String),
      },
    });
    await expect(
      env.DB.prepare('SELECT "email" FROM "user" WHERE "id" = ?')
        .bind(body.user.userId)
        .first<{ email: string }>(),
    ).resolves.toEqual({ email: EMAIL });
    // The response carries the identity and nothing else: no session token,
    // no password echo, no account internals.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    // And no session EXISTS, not merely none returned. Better Auth's autoSignIn
    // default would have created one here — a live credential row for an admin
    // who has never signed in, whose token nobody received. create-auth.ts
    // disables it; this is the assertion that keeps bootstrap's "no session"
    // posture literally true rather than only true of the response.
    await expect(
      env.DB.prepare(
        'SELECT COUNT(*) AS total FROM "session" WHERE "userId" = ?',
      )
        .bind(body.user.userId)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });

    await expect(accessRow(body.user.userId)).resolves.toEqual({
      account_type: "platform_admin",
      status: "active",
    });

    // Full loop: the new admin signs in through the normal mounted route and
    // uses the session to reach a platform-admin-only surface.
    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const signedIn = await worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        headers: {
          "content-type": "application/json",
          origin: AUTH_ORIGIN,
        },
        method: "POST",
      }),
      env,
    );
    expect(signedIn.status).toBe(200);

    const setCookie = signedIn.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("bootstrap admin sign-in returned no session cookie");
    }
    const cookie = setCookie.split(";", 1)[0] as string;

    const provisioned = await exports.default.fetch(
      new Request(`${AUTH_ORIGIN}/v1/platform/tenants`, {
        body: JSON.stringify({
          hostname: "shop.bootstrapped.test",
          shopName: "Bootstrapped Shop",
          tenantId: "bootstrapped-shop",
        }),
        headers: {
          "content-type": "application/json",
          cookie,
          origin: AUTH_ORIGIN,
        },
        method: "POST",
      }),
    );

    expect(provisioned.status).toBe(201);
    await expect(provisioned.json()).resolves.toMatchObject({
      tenant: { status: "active", tenantId: "bootstrapped-shop" },
    });
  });

  it("records an audit row that never carries the email", async () => {
    const row = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json, reason, resource_id, resource_type,
              tenant_id
       FROM audit_events
       WHERE action = 'platform.bootstrap'`,
    ).first<{
      actor_user_id: string | null;
      metadata_json: string | null;
      reason: string | null;
      resource_id: string | null;
      resource_type: string;
      tenant_id: string | null;
    }>();

    const admin = await env.DB.prepare(
      "SELECT user_id FROM identity_access WHERE account_type = 'platform_admin'",
    ).first<{ user_id: string }>();

    expect(row).not.toBeNull();
    expect(row?.tenant_id).toBeNull();
    expect(row?.metadata_json).toBeNull();
    expect(row?.resource_type).toBe("identity_access");
    expect(row?.resource_id).toBe(admin?.user_id);
    expect(row?.actor_user_id).toBe(admin?.user_id);
    expect(JSON.stringify(row)).not.toContain(EMAIL);
    expect(JSON.stringify(row)).not.toContain("founder");
  });
});

describe("platform bootstrap after it has been used", () => {
  it("returns 404 for a second attempt with the same valid token", async () => {
    const before = await countUsers();
    const response = await bootstrap({
      body: { email: "second@bootstrap.test", password: PASSWORD },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });

    // No second user, and the original admin is untouched.
    await expect(countUsers()).resolves.toBe(before);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM identity_access
         WHERE account_type = 'platform_admin'`,
      ).first<{ total: number }>(),
    ).resolves.toEqual({ total: 1 });
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
        .bind("second@bootstrap.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  // The route refuses a second bootstrap at two independent layers: the
  // isBootstrapAllowed gate, and a re-check inside bootstrapPlatformAdmin.
  // Either alone would produce the 404 above, so each is pinned directly —
  // otherwise one could rot silently behind the other.
  it("closes the outer guard once an admin exists", async () => {
    const { isBootstrapAllowed } = await import("../src/platform/bootstrap");

    await expect(
      isBootstrapAllowed(env, bootstrapRequest({ body: {} })),
    ).resolves.toBe(false);
  });

  it("reports a conflict, not a success, when the admin row is already claimed", async () => {
    // The TOCTOU loser's final state: bootstrapPlatformAdmin is entered on a
    // platform that already has an admin, standing in for the racer whose
    // zero-admin check passed a moment before the winner's INSERT landed. The
    // real race cannot be interleaved deterministically in a single-threaded
    // test, so this pins the outcome that matters — a conflict rather than a
    // second platform admin.
    const { bootstrapPlatformAdmin } = await import("../src/platform/bootstrap");

    const before = await countUsers();
    const result = await bootstrapPlatformAdmin(
      env,
      { email: "racer@bootstrap.test", name: "Racer", password: PASSWORD },
      Date.now(),
    );

    // Rejected before the Better Auth user was ever created, so this path
    // leaves no orphan at all.
    expect(result).toEqual({ status: "not_found" });
    await expect(countUsers()).resolves.toBe(before);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM identity_access
         WHERE account_type = 'platform_admin'`,
      ).first<{ total: number }>(),
    ).resolves.toEqual({ total: 1 });
  });
});
