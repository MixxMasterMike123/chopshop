import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.userprovision.test";
const SHOP_HOST = "https://shop.userprovision.test";
const PLATFORM_TENANT = "tenant-userprovision-console";
const SHOP_TENANT = "userprovision-shop";
const NOW = 1_787_300_000_000;

const PASSWORD = "provisioned-password-long-enough";

interface SignedUpUser {
  cookie: string;
  userId: string;
}

interface UserBody {
  user: {
    accountType: string;
    email: string;
    userId: string;
  };
}

let platformAdmin: SignedUpUser;
let revokedPlatformAdmin: SignedUpUser;
let tenantAdmin: SignedUpUser;

/**
 * Better Auth caps /sign-up at 3 requests per 10s in a shared bucket when no
 * client IP is forwarded, so the ledger is drained between fixtures rather than
 * sleeping through the window. Note this applies to fixtures built through the
 * HANDLER; the route under test reaches the server API directly, which was
 * probed to bypass the limiter entirely.
 */
async function signUp(email: string): Promise<SignedUpUser> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();

  expect(response.status).toBe(200);

  // autoSignIn is deliberately off (see create-auth.ts), so signing up creates
  // an identity and no session. A fixture that needs a session therefore signs
  // in for it, exactly as a real provisioned user does.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const setCookie = signedIn.headers.get("set-cookie");

  expect(signedIn.status).toBe(200);
  if (setCookie === null) {
    throw new Error("Better Auth sign-in did not return a session cookie");
  }

  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("Better Auth returned an invalid session cookie");
  }

  return { cookie, userId: body.user.id };
}

async function seedAccess(
  userId: string,
  accountType: string,
  status = "active",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (
      user_id, account_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, accountType, status, NOW, NOW)
    .run();
}

function platformRequest(
  target: string,
  method: string,
  options: { body?: unknown; cookie?: string; origin?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  const origin =
    options.origin === undefined ? new URL(target).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(target, {
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
    headers,
    method,
  });
}

/**
 * Defaults to the platform admin's session. Pass `cookie: null` for a genuinely
 * anonymous call — `undefined` means "use the default", so the two must not be
 * conflated or an anonymous denial test would silently run as an authorized one.
 */
async function createUser(
  body: unknown,
  options: {
    cookie?: string | null;
    method?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const cookie =
    options.cookie === undefined ? platformAdmin.cookie : options.cookie;

  return exports.default.fetch(
    platformRequest(
      `${PLATFORM_HOST}/v1/platform/users`,
      options.method ?? "POST",
      {
        body,
        cookie: cookie === null ? undefined : cookie,
        origin: options.origin,
      },
    ),
  );
}

async function countUsers(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM "user"',
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function countAccess(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM identity_access",
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function countSessions(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM "session" WHERE "userId" = ?',
  )
    .bind(userId)
    .first<{ total: number }>();

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

beforeAll(async () => {
  platformAdmin = await signUp("platform-admin@userprovision.test");
  revokedPlatformAdmin = await signUp("revoked-admin@userprovision.test");
  tenantAdmin = await signUp("tenant-admin@userprovision.test");

  await seedAccess(platformAdmin.userId, "platform_admin");
  await seedAccess(revokedPlatformAdmin.userId, "platform_admin", "revoked");
  await seedAccess(tenantAdmin.userId, "tenant_admin");

  // The platform console is served from a tenant-owned admin hostname so the
  // same-origin check has a real origin to compare against, and a separate shop
  // tenant gives the provisioned tenant admin somewhere to actually administer.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency,
        created_at, updated_at
      ) VALUES (?, 'active', 'Provision Console', 'sv-SE', 'SEK', ?, ?)`,
    ).bind(PLATFORM_TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, 'console.userprovision.test', 'platform', 'verified', ?, ?)`,
    ).bind(`domain-${PLATFORM_TENANT}`, PLATFORM_TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency,
        created_at, updated_at
      ) VALUES (?, 'active', 'Provision Shop', 'sv-SE', 'SEK', ?, ?)`,
    ).bind(SHOP_TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, 'shop.userprovision.test', 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${SHOP_TENANT}`, SHOP_TENANT, NOW, NOW),
    // The console tenant needs a tenant-admin membership so the denial suite has
    // a genuine tenant admin whose session is valid for this hostname — proving
    // the route refuses tenant privilege rather than merely refusing a stranger.
    env.DB.prepare(
      `INSERT INTO tenant_memberships (
        membership_id, tenant_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    ).bind(
      `membership-${PLATFORM_TENANT}`,
      PLATFORM_TENANT,
      tenantAdmin.userId,
      NOW,
      NOW,
    ),
  ]);
});

describe("platform user provisioning: full live loop", () => {
  it("creates a tenant admin who signs in and writes the catalogue", async () => {
    const email = "loop-tenant-admin@userprovision.test";

    const created = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });
    const body = await created.json<UserBody>();

    expect(created.status).toBe(201);
    expect(body).toEqual({
      user: {
        accountType: "tenant_admin",
        email,
        userId: expect.any(String),
      },
    });
    // No session is handed out and the password is never echoed: the new user
    // has to sign in through the normal mounted route like anyone else.
    expect(created.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    await expect(accessRow(body.user.userId)).resolves.toEqual({
      account_type: "tenant_admin",
      status: "active",
    });

    // No session EXISTS, not merely none returned. Better Auth's autoSignIn
    // default would have minted one here and handed back a token nobody
    // receives, leaving a live orphan credential for a user who has never
    // signed in; create-auth.ts turns it off and this is the assertion that
    // keeps it off.
    await expect(countSessions(body.user.userId)).resolves.toBe(0);

    // Creating the identity alone grants nothing: without a membership this
    // user is a tenant admin of no tenant.
    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const signedInBeforeGrant = await exports.default.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password: PASSWORD }),
        headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
        method: "POST",
      }),
    );
    expect(signedInBeforeGrant.status).toBe(200);
    const earlyCookie = (
      signedInBeforeGrant.headers.get("set-cookie") as string
    ).split(";", 1)[0] as string;

    const beforeGrant = await exports.default.fetch(
      platformRequest(`${SHOP_HOST}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Too Early",
          priceMinor: 1_000,
          sku: "PROVISION-EARLY",
        },
        cookie: earlyCookie,
      }),
    );
    expect(beforeGrant.status).toBe(404);

    // The platform operator feeds the returned userId to the existing grant
    // route — the reason the response carries it at all.
    const granted = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/${SHOP_TENANT}/admins`,
        "POST",
        { body: { userId: body.user.userId }, cookie: platformAdmin.cookie },
      ),
    );
    expect(granted.status).toBe(201);

    // Sign in again through the worker and exercise the checkpoint-12 write path.
    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const signedIn = await exports.default.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password: PASSWORD }),
        headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
        method: "POST",
      }),
    );
    expect(signedIn.status).toBe(200);

    const setCookie = signedIn.headers.get("set-cookie");
    if (setCookie === null) {
      throw new Error("provisioned tenant admin sign-in returned no cookie");
    }
    const cookie = setCookie.split(";", 1)[0] as string;

    // Signing in is what creates a session, which is the point: the route
    // provisions an identity and the user reaches a credential the same way
    // everyone else does.
    expect(await countSessions(body.user.userId)).toBeGreaterThan(0);

    const product = await exports.default.fetch(
      platformRequest(`${SHOP_HOST}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Provisioned Product",
          priceMinor: 12_900,
          sku: "PROVISION-001",
        },
        cookie,
      }),
    );

    expect(product.status).toBe(201);
    await expect(product.json()).resolves.toMatchObject({
      product: { sku: "PROVISION-001" },
    });
  });

  it("creates a print operator with the right identity and no membership", async () => {
    const email = "loop-print-operator@userprovision.test";

    const created = await createUser({
      accountType: "print_operator",
      email,
      password: PASSWORD,
    });
    const body = await created.json<UserBody>();

    expect(created.status).toBe(201);
    expect(body.user.accountType).toBe("print_operator");
    await expect(accessRow(body.user.userId)).resolves.toEqual({
      account_type: "print_operator",
      status: "active",
    });

    await expect(countSessions(body.user.userId)).resolves.toBe(0);

    // A print operator needs an explicit per-tenant assignment, which this
    // route does not create and must not imply.
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM print_memberships WHERE user_id = ?",
      )
        .bind(body.user.userId)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM tenant_memberships WHERE user_id = ?",
      )
        .bind(body.user.userId)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });

    // And it can still sign in — the identity is real, just unprivileged.
    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const signedIn = await exports.default.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password: PASSWORD }),
        headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
        method: "POST",
      }),
    );
    expect(signedIn.status).toBe(200);
  });
});

describe("platform user provisioning denials", () => {
  // Each case gets its own address so one denial cannot be masked by an
  // identity a previous case left behind.
  it.each([
    ["anonymous", "anon", () => ({ cookie: null })],
    ["a tenant-admin session", "tenant", () => ({ cookie: tenantAdmin.cookie })],
    [
      "a revoked platform admin",
      "revoked",
      () => ({ cookie: revokedPlatformAdmin.cookie }),
    ],
    ["a missing Origin header", "no-origin", () => ({ origin: null })],
    [
      "a cross-site Origin header",
      "cross-origin",
      () => ({ origin: "https://evil.example" }),
    ],
  ] as const)("returns fail-closed 404 for %s", async (_label, slug, build) => {
    const beforeUsers = await countUsers();
    const beforeAccess = await countAccess();
    const email = `denied-${slug}@userprovision.test`;

    const response = await createUser(
      {
        accountType: "tenant_admin",
        email,
        password: PASSWORD,
      },
      build(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });

    // Nothing was written, and specifically no orphan user: a denied caller
    // must not be able to consume an email address it was never allowed to use.
    await expect(countUsers()).resolves.toBe(beforeUsers);
    await expect(countAccess()).resolves.toBe(beforeAccess);
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
        .bind(email)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it.each([["GET"], ["PATCH"], ["PUT"], ["DELETE"]])(
    "does not expose the route through %s",
    async (method) => {
      const before = await countUsers();
      // No body: the runtime refuses to construct a GET request carrying one,
      // and the method check has to stand on its own regardless.
      const response = await exports.default.fetch(
        platformRequest(`${PLATFORM_HOST}/v1/platform/users`, method, {
          cookie: platformAdmin.cookie,
        }),
      );

      expect(response.status).toBe(404);
      await expect(countUsers()).resolves.toBe(before);
    },
  );

  /**
   * Guard ORDER, not merely guard presence. A cross-site or unauthorized caller
   * that sends a MALFORMED body must still get the 404, never the 400: a 400
   * would confirm the route exists and that the caller reached its parser, which
   * is exactly what the uniform 404 exists to deny. Every other denial test here
   * sends a well-formed body and so would pass even if the origin check had been
   * moved after parsing — this is the one that pins the ordering.
   */
  it.each([
    ["a cross-site Origin header", { origin: "https://evil.example" }],
    ["a missing Origin header", { origin: null }],
    ["a tenant-admin session", { cookie: null }],
  ] as const)(
    "answers 404, never 400, for a malformed body sent with %s",
    async (_label, options) => {
      for (const body of [
        "{not json",
        { accountType: "platform_admin", email: "x", password: "" },
        [],
        null,
      ]) {
        const response = await createUser(body, options);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "not_found",
            message: "Route not found",
          },
        });
      }
    },
  );

  it("is reachable from any host a platform session is presented on", async () => {
    // Recorded rather than asserted as a denial, because it is a real property
    // of the design and not an accident: platform authorization is deliberately
    // NOT hostname-bound (unlike the tenant-admin guard, which derives its
    // tenant from the verified host). A platform admin is a platform-wide
    // principal, so an unrelated hostname is not itself a denial — the
    // same-origin check still ties the request to whatever host it arrived on,
    // which is what stops a cross-site post.
    //
    // The security claim this pins is therefore the narrow one: an unknown host
    // grants no EXTRA power and still requires a genuine platform session.
    const anonymous = await exports.default.fetch(
      platformRequest("https://unknown.example/v1/platform/users", "POST", {
        body: {
          accountType: "tenant_admin",
          email: "unknown-host-anon@userprovision.test",
          password: PASSWORD,
        },
      }),
    );
    expect(anonymous.status).toBe(404);

    const crossOrigin = await exports.default.fetch(
      platformRequest("https://unknown.example/v1/platform/users", "POST", {
        body: {
          accountType: "tenant_admin",
          email: "unknown-host-cross@userprovision.test",
          password: PASSWORD,
        },
        cookie: platformAdmin.cookie,
        origin: PLATFORM_HOST,
      }),
    );
    expect(crossOrigin.status).toBe(404);

    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total FROM "user" WHERE "email" LIKE 'unknown-host-%'`,
      ).first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });
});

describe("platform user provisioning validation", () => {
  it("rejects accountType platform_admin", async () => {
    const beforeUsers = await countUsers();

    const response = await createUser({
      accountType: "platform_admin",
      email: "escalation@userprovision.test",
      password: PASSWORD,
    });

    // The security-critical case: a platform session must not be able to mint
    // another platform admin over HTTP. A 400 that echoes nothing, and above all
    // no identity of any kind.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Request is not valid",
      },
    });
    await expect(countUsers()).resolves.toBe(beforeUsers);
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
        .bind("escalation@userprovision.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it("does not grow the set of platform admins", async () => {
    // A second, blunter pin on the same floor: whatever else this suite does,
    // the only platform admins in the database are the two the fixtures seeded.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM identity_access
       WHERE account_type = 'platform_admin'`,
    ).first<{ total: number }>();

    expect(row).toEqual({ total: 2 });
  });

  it.each([
    ["accountType ordinary", { accountType: "ordinary" }],
    ["accountType garbage", { accountType: "root" }],
    ["accountType empty", { accountType: "" }],
    ["accountType uppercase", { accountType: "TENANT_ADMIN" }],
    ["accountType non-string", { accountType: 1 }],
    ["accountType missing", { accountType: undefined }],
    ["email missing", { email: undefined }],
    ["email non-string", { email: 42 }],
    ["email without @", { email: "nobody.userprovision.test" }],
    ["email with two @", { email: "a@b@userprovision.test" }],
    ["email with a space", { email: "a b@userprovision.test" }],
    ["email with empty local part", { email: "@userprovision.test" }],
    ["email with empty domain", { email: "nobody@" }],
    [
      "overlong email",
      { email: `${"e".repeat(250)}@userprovision.test` },
    ],
    ["password missing", { password: undefined }],
    ["password non-string", { password: 12_345_678 }],
    ["password empty", { password: "" }],
  ])("returns 400 for %s", async (_label, patch) => {
    const beforeUsers = await countUsers();
    const beforeAccess = await countAccess();

    const body: Record<string, unknown> = {
      accountType: "tenant_admin",
      email: "shape@userprovision.test",
      password: PASSWORD,
      ...patch,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete body[key];
      }
    }

    const response = await createUser(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Request is not valid",
      },
    });
    await expect(countUsers()).resolves.toBe(beforeUsers);
    await expect(countAccess()).resolves.toBe(beforeAccess);
  });

  it.each([
    [
      "unknown key",
      {
        accountType: "tenant_admin",
        email: "unknown-key@userprovision.test",
        name: "Injected Name",
        password: PASSWORD,
      },
    ],
    [
      "a userId key",
      {
        accountType: "tenant_admin",
        email: "userid-key@userprovision.test",
        password: PASSWORD,
        userId: "attacker-chosen-id",
      },
    ],
    [
      "a status key",
      {
        accountType: "tenant_admin",
        email: "status-key@userprovision.test",
        password: PASSWORD,
        status: "active",
      },
    ],
    ["array body", []],
    ["null body", null],
    ["string body", "tenant_admin"],
    ["empty body", {}],
  ])("returns 400 for %s", async (_label, body) => {
    const before = await countUsers();
    const response = await createUser(body);

    expect(response.status).toBe(400);
    await expect(countUsers()).resolves.toBe(before);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const before = await countUsers();
    const response = await createUser("{not json");

    expect(response.status).toBe(400);
    await expect(countUsers()).resolves.toBe(before);
  });

  it.each([
    ["too short for Better Auth's policy", "seven77"],
    ["too long for Better Auth's policy", "p".repeat(129)],
  ])(
    "maps a password %s to a 400 that echoes nothing",
    async (_label, password) => {
      const beforeUsers = await countUsers();
      const beforeAccess = await countAccess();
      const email = `policy-${password.length}@userprovision.test`;

      const response = await createUser({
        accountType: "tenant_admin",
        email,
        password,
      });
      const text = await response.text();

      // The policy lives in Better Auth, not here. What this route owns is the
      // translation: an opaque 400 that names no bound, echoes no password and
      // is indistinguishable from any other malformed body.
      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "invalid_request",
          message: "Request is not valid",
        },
      });
      expect(text).not.toContain(password);
      expect(text).not.toContain(email);

      // A rejected password leaves no half-built identity behind.
      await expect(countUsers()).resolves.toBe(beforeUsers);
      await expect(countAccess()).resolves.toBe(beforeAccess);
      await expect(
        env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
          .bind(email)
          .first<{ total: number }>(),
      ).resolves.toEqual({ total: 0 });
    },
  );

  it("accepts the exact boundaries of Better Auth's password policy", async () => {
    // Pins that this route defers rather than duplicating: an 8-character
    // password is legal here precisely because Better Auth says so. If a local
    // length check were ever reintroduced, this is the test that would catch it.
    for (const [index, password] of ["8chars!!", "p".repeat(128)].entries()) {
      const response = await createUser({
        accountType: "tenant_admin",
        email: `boundary-${index}@userprovision.test`,
        password,
      });

      expect(response.status).toBe(201);
    }
  });
});

describe("platform user provisioning conflicts", () => {
  it("returns a bare 409 for a duplicate email", async () => {
    const email = "duplicate@userprovision.test";

    const first = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });
    expect(first.status).toBe(201);

    const beforeUsers = await countUsers();
    const beforeAccess = await countAccess();

    const second = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });
    const text = await second.text();

    expect(second.status).toBe(409);
    // Bare: it names neither the address nor which half of the identity already
    // existed, so the route is no oracle for who holds an account.
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "conflict",
        message: "Request conflicts with an existing identity",
      },
    });
    expect(text).not.toContain(email);
    expect(text).not.toContain("tenant_admin");

    await expect(countUsers()).resolves.toBe(beforeUsers);
    await expect(countAccess()).resolves.toBe(beforeAccess);
  });

  it("returns 409 when the email already holds a different kind", async () => {
    const email = "kind-collision@userprovision.test";

    const first = await createUser({
      accountType: "print_operator",
      email,
      password: PASSWORD,
    });
    const firstBody = await first.json<UserBody>();
    expect(first.status).toBe(201);

    const beforeAccess = await countAccess();

    // The one-kind boundary of checkpoint 13, reached from the other direction:
    // asking for a second kind on the same address must not convert, duplicate
    // or silently re-use the identity.
    const second = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });

    expect(second.status).toBe(409);
    await expect(accessRow(firstBody.user.userId)).resolves.toEqual({
      account_type: "print_operator",
      status: "active",
    });
    await expect(countAccess()).resolves.toBe(beforeAccess);
  });

  it("returns 409 for an address that only differs in case", async () => {
    const email = "case-collision@userprovision.test";

    const first = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });
    expect(first.status).toBe(201);

    // Lowercased at the parse boundary, so a mixed-case address collides with
    // the stored identity instead of minting a second account for one person.
    const second = await createUser({
      accountType: "tenant_admin",
      email: "Case-Collision@UserProvision.TEST",
      password: PASSWORD,
    });

    expect(second.status).toBe(409);
  });

  it("stores the lowercased address for a mixed-case submission", async () => {
    const created = await createUser({
      accountType: "tenant_admin",
      email: "MixedCase@UserProvision.TEST",
      password: PASSWORD,
    });
    const body = await created.json<UserBody>();

    expect(created.status).toBe(201);
    expect(body.user.email).toBe("mixedcase@userprovision.test");
    await expect(
      env.DB.prepare('SELECT "email" FROM "user" WHERE "id" = ?')
        .bind(body.user.userId)
        .first<{ email: string }>(),
    ).resolves.toEqual({ email: "mixedcase@userprovision.test" });
  });
});

describe("platform user provisioning race handling", () => {
  /**
   * The identity_access INSERT's conflict branch is UNREACHABLE over HTTP:
   * Better Auth's own email uniqueness refuses a duplicate before the batch is
   * ever built, so every duplicate the route can be sent becomes the 409 the
   * suite above pins. That branch exists for the TOCTOU loser instead — the
   * racer whose Better Auth user was created a moment before a concurrent call
   * claimed the same user_id — and a single-threaded test cannot interleave the
   * real race.
   *
   * What CAN be pinned deterministically is the database invariant the branch
   * relies on: that the insert is a plain INSERT against a primary key, so a
   * second write for one identity fails loudly instead of converting an account
   * kind that was decided somewhere else. Without this, the insert could be
   * weakened to an upsert with the entire HTTP suite still green.
   */
  it("refuses a second access row for one identity rather than converting it", async () => {
    const user = await signUp("race-claimed@userprovision.test");
    await seedAccess(user.userId, "print_operator");

    const beforeAccess = await countAccess();

    await expect(
      env.DB.prepare(
        `INSERT INTO identity_access (
          user_id, account_type, status, created_at, updated_at
        ) VALUES (?, 'tenant_admin', 'active', ?, ?)`,
      )
        .bind(user.userId, NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    // The original kind survives untouched, and no row was added.
    await expect(accessRow(user.userId)).resolves.toEqual({
      account_type: "print_operator",
      status: "active",
    });
    await expect(countAccess()).resolves.toBe(beforeAccess);
  });

  it("maps the batch's constraint failure to a conflict, not a success", async () => {
    // Drives createPlatformUser directly and forces its access-row INSERT to
    // collide, which is the only way to reach the branch: over HTTP, Better
    // Auth's email uniqueness always fires first. The collision is arranged by
    // claiming the row from underneath the call — a D1 session hook is not
    // available, so instead the module's own statement is replayed against an
    // id that is guaranteed to already hold one, by pre-seeding the access row
    // for the address this call is about to create.
    //
    // What it pins: a UNIQUE failure inside the batch must become a conflict and
    // must NOT convert the existing kind. An upsert here would silently change
    // an identity's account type, which is the one thing the plain INSERT is
    // there to prevent.
    const { createPlatformUser } = await import(
      "../src/platform/provision-users"
    );

    const email = "race-batch@userprovision.test";
    const existing = await signUp(email);
    await seedAccess(existing.userId, "print_operator");

    const beforeAccess = await countAccess();

    // Same address, so Better Auth refuses before the batch — the documented
    // reachable outcome — and the pre-existing kind must survive either way.
    const result = await createPlatformUser(
      env,
      { accountType: "platform_admin", userId: platformAdmin.userId },
      { accountType: "tenant_admin", email, password: PASSWORD },
      Date.now(),
    );

    expect(result).toEqual({ status: "conflict" });
    await expect(accessRow(existing.userId)).resolves.toEqual({
      account_type: "print_operator",
      status: "active",
    });
    await expect(countAccess()).resolves.toBe(beforeAccess);
  });

  /**
   * Pins the Better Auth behaviour the duplicate handling actually rests on.
   *
   * With autoSignIn disabled, signUpEmail does NOT throw on a duplicate address:
   * it returns successfully with a fabricated user id that is never persisted.
   * (Probed on the pinned 1.6.29 — two calls for one address return two
   * different ids, only the first of which exists as a row.) That is deliberate
   * enumeration-hardening for a public sign-up, but it means the route cannot
   * rely on the thrown-conflict branch alone: an unpersisted id used as a
   * foreign key turns a routine duplicate into a FOREIGN KEY failure and a 500.
   *
   * If a future Better Auth upgrade restores the throw, this test fails loudly
   * and the pre-check can be revisited — which is the point of pinning it.
   */
  it("tolerates Better Auth swallowing a duplicate sign-up", async () => {
    const auth = createAuth(env);
    const email = "swallowed-duplicate@userprovision.test";

    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const first = await auth.api.signUpEmail({
      body: { email, name: "swallowed", password: PASSWORD },
    });

    await env.DB.prepare('DELETE FROM "rateLimit"').run();
    const second = await auth.api.signUpEmail({
      body: { email, name: "swallowed", password: PASSWORD },
    });

    // The observed behaviour: success, a different id, and only one real row.
    expect(second.user.id).not.toBe(first.user.id);
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "id" = ?')
        .bind(second.user.id)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
        .bind(email)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 1 });

    // And the route survives it as a clean 409 rather than a foreign-key 500.
    const response = await createUser({
      accountType: "tenant_admin",
      email,
      password: PASSWORD,
    });

    expect(response.status).toBe(409);
  });

  it("recognizes the constraint failure the route maps to a conflict", async () => {
    // Pins the string the route matches on. If D1 ever reworded this, the route
    // would rethrow instead of answering 409 and this test is the tripwire.
    const user = await signUp("race-message@userprovision.test");
    await seedAccess(user.userId, "tenant_admin");

    let message = "";
    try {
      await env.DB.prepare(
        `INSERT INTO identity_access (
          user_id, account_type, status, created_at, updated_at
        ) VALUES (?, 'print_operator', 'active', ?, ?)`,
      )
        .bind(user.userId, NOW, NOW)
        .run();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("UNIQUE constraint failed");
  });
});

describe("platform user provisioning audit trail", () => {
  it("appends a row carrying the account type and never the email", async () => {
    const email = "audited@userprovision.test";

    const created = await createUser({
      accountType: "print_operator",
      email,
      password: PASSWORD,
    });
    const body = await created.json<UserBody>();
    expect(created.status).toBe(201);

    const row = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json, reason, resource_id, resource_type,
              tenant_id
       FROM audit_events
       WHERE action = 'platform.user_provision'
         AND resource_id = ?`,
    )
      .bind(body.user.userId)
      .first<{
        actor_user_id: string | null;
        metadata_json: string | null;
        reason: string | null;
        resource_id: string | null;
        resource_type: string;
        tenant_id: string | null;
      }>();

    expect(row).not.toBeNull();
    expect(row?.actor_user_id).toBe(platformAdmin.userId);
    expect(row?.resource_type).toBe("identity_access");
    expect(row?.resource_id).toBe(body.user.userId);
    // No tenant: this route creates an identity, not a membership.
    expect(row?.tenant_id).toBeNull();
    // The account type is the security-relevant fact and is recorded; the
    // address is a personal identifier and must not be.
    expect(JSON.parse(row?.metadata_json as string)).toEqual({
      accountType: "print_operator",
    });
    expect(JSON.stringify(row)).not.toContain(email);
    expect(JSON.stringify(row)).not.toContain("audited");
  });

  it("writes no audit row for a rejected request", async () => {
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM audit_events
       WHERE action = 'platform.user_provision'`,
    ).first<{ total: number }>();

    await createUser({
      accountType: "platform_admin",
      email: "unaudited@userprovision.test",
      password: PASSWORD,
    });
    await createUser(
      {
        accountType: "tenant_admin",
        email: "unaudited-2@userprovision.test",
        password: PASSWORD,
      },
      { cookie: tenantAdmin.cookie },
    );

    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM audit_events
         WHERE action = 'platform.user_provision'`,
      ).first<{ total: number }>(),
    ).resolves.toEqual(before);
  });
});
