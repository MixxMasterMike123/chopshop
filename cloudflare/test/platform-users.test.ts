import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { authorizePlatformAdmin } from "../src/auth/live-authorization";
import { parseAuthEmailJob } from "../src/email/auth-email-job";
import { issueInvite } from "../src/platform/invites";

/**
 * CP3-B — the platform user directory, and the route-level guard contract of
 * every identity route (directory, read, deactivate, reactivate, invite,
 * membership revoke): no session and a tenant-admin session get the opaque
 * 404; only a live platform session reaches the handler. Lifecycle and invite
 * behaviour have their own suites (user-lifecycle, invites).
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.platformusers.example.com";
const SHOP_A = "platformusers-shop-a";
const SHOP_B = "platformusers-shop-b";
const NOW = 1_789_000_000_000;
const PASSWORD = "test-password-long-enough";
const OPAQUE_404 = { error: { code: "not_found", message: "Route not found" } };

interface Person {
  cookie: string;
  email: string;
  userId: string;
}

let operator: Person;
let shopAdmin: Person;
let printOperator: Person;
let suspendedAdmin: Person;
let orphan: Person;
let probeTarget: Person;

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

async function signUp(email: string, name: string): Promise<Person> {
  await drainAuthLimiter();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ user: { id: string } }>();
  return { cookie: await signIn(email), email, userId: body.user.id };
}

async function signIn(email: string): Promise<string> {
  await drainAuthLimiter();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
}

async function seedAccess(userId: string, accountType: string, status = "active") {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, accountType, status, NOW, NOW)
    .run();
}

async function seedTenant(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Test Shop ${tenantId}`, NOW, NOW)
    .run();
}

async function seedMembership(tenantId: string, userId: string, status = "active") {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), tenantId, userId, status, NOW, NOW)
    .run();
}

function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string | null;
    origin?: string | null;
    shopId?: string;
  } = {},
): Promise<Response> {
  const target = `${PLATFORM_HOST}${path}`;
  const headers = new Headers();
  const cookie = options.cookie === undefined ? operator.cookie : options.cookie;
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  const origin = options.origin === undefined ? PLATFORM_HOST : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.shopId !== undefined) {
    headers.set("x-shop-id", options.shopId);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(target, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method,
    }),
    env,
  );
}

interface DirectoryUserBody {
  accountType: string | null;
  createdAt: string;
  email: string;
  hasPassword: boolean;
  invite: { createdAt: string; expired?: true; expiresAt: string; pending: boolean; status: string } | null;
  memberships: { role: string; status: string; tenantId: string }[];
  name: string;
  printMemberships: { status: string; tenantId: string }[];
  status: string | null;
  userId: string;
}

interface DirectoryBody {
  nextCursor: string | null;
  users: DirectoryUserBody[];
}

const FORBIDDEN_KEY = /password|hash|token|secret/i;

/** Every [key, value] pair anywhere in the value, at any depth. */
function allEntries(value: unknown, into: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(value)) {
    for (const item of value) {
      allEntries(item, into);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.push([key, child]);
      allEntries(child, into);
    }
  }
  return into;
}

/**
 * The forbidden-field walk. The ONE key allowed to match the pattern is
 * `hasPassword`, and only as a boolean: the fact that a password exists, never
 * anything derived from its value.
 */
function forbiddenEntries(body: unknown): [string, unknown][] {
  return allEntries(body).filter(
    ([key, value]) =>
      FORBIDDEN_KEY.test(key) && !(key === "hasPassword" && typeof value === "boolean"),
  );
}

beforeAll(async () => {
  await seedTenant(SHOP_A);
  await seedTenant(SHOP_B);

  operator = await signUp("platform-operator@example.com", "Test Operator");
  shopAdmin = await signUp("shop-admin@example.com", "Test Admin");
  printOperator = await signUp("print-operator@example.com", "Test Printer");
  suspendedAdmin = await signUp("suspended-admin@example.com", "Test Suspended");
  orphan = await signUp("orphan@example.com", "Test Orphan");
  probeTarget = await signUp("probe-target@example.com", "Test Probe");

  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(shopAdmin.userId, "tenant_admin");
  await seedAccess(printOperator.userId, "print_operator");
  await seedAccess(suspendedAdmin.userId, "tenant_admin", "suspended");
  await seedAccess(probeTarget.userId, "tenant_admin");

  await seedMembership(SHOP_A, shopAdmin.userId);
  await seedMembership(SHOP_B, suspendedAdmin.userId);
  await seedMembership(SHOP_A, probeTarget.userId);
  await env.DB.prepare(
    `INSERT INTO print_memberships (membership_id, tenant_id, user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), SHOP_A, printOperator.userId, NOW, NOW)
    .run();
});

describe("GET /v1/platform/users — the directory", () => {
  it("lists every identity with its kind, state and memberships", async () => {
    const response = await call("GET", "/v1/platform/users", { origin: null });
    expect(response.status).toBe(200);
    const body = await response.json<DirectoryBody>();

    expect(Object.keys(body).sort()).toEqual(["nextCursor", "users"]);
    expect(body.nextCursor).toBeNull();

    const byId = new Map(body.users.map((user) => [user.userId, user]));
    expect(byId.get(shopAdmin.userId)).toEqual({
      accountType: "tenant_admin",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      email: "shop-admin@example.com",
      hasPassword: true,
      invite: null,
      memberships: [{ role: "admin", status: "active", tenantId: SHOP_A }],
      name: "Test Admin",
      printMemberships: [],
      status: "active",
      userId: shopAdmin.userId,
    });
    expect(byId.get(printOperator.userId)).toMatchObject({
      accountType: "print_operator",
      memberships: [],
      printMemberships: [{ status: "active", tenantId: SHOP_A }],
    });
    expect(byId.get(suspendedAdmin.userId)).toMatchObject({
      accountType: "tenant_admin",
      status: "suspended",
    });
    // An identity-less user is listed, with nulls, so an operator can find it.
    expect(byId.get(orphan.userId)).toMatchObject({ accountType: null, status: null });
    expect(byId.get(operator.userId)).toMatchObject({ accountType: "platform_admin" });

    // Ordered by user id.
    const ids = body.users.map((user) => user.userId);
    expect(ids).toEqual([...ids].sort());
  });

  it("filters by account type and by tenant", async () => {
    const tenantAdmins = await (
      await call("GET", "/v1/platform/users?accountType=tenant_admin")
    ).json<DirectoryBody>();
    expect(tenantAdmins.users.every((user) => user.accountType === "tenant_admin")).toBe(true);
    expect(tenantAdmins.users.map((user) => user.userId).sort()).toEqual(
      [shopAdmin.userId, suspendedAdmin.userId, probeTarget.userId].sort(),
    );

    // Tenant and print memberships both count as being "in" a shop.
    const inShopA = await (
      await call("GET", `/v1/platform/users?tenantId=${SHOP_A}`)
    ).json<DirectoryBody>();
    expect(inShopA.users.map((user) => user.userId).sort()).toEqual(
      [shopAdmin.userId, printOperator.userId, probeTarget.userId].sort(),
    );

    const both = await (
      await call("GET", `/v1/platform/users?tenantId=${SHOP_A}&accountType=print_operator`)
    ).json<DirectoryBody>();
    expect(both.users.map((user) => user.userId)).toEqual([printOperator.userId]);

    const none = await (
      await call("GET", "/v1/platform/users?tenantId=no-such-shop")
    ).json<DirectoryBody>();
    expect(none).toEqual({ nextCursor: null, users: [] });
  });

  it("pages with a cursor, without gaps or repeats", async () => {
    const full = await (await call("GET", "/v1/platform/users")).json<DirectoryBody>();
    expect(full.users.length).toBeGreaterThanOrEqual(6);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const page: DirectoryBody = await (
        await call("GET", `/v1/platform/users${query}`)
      ).json<DirectoryBody>();
      expect(page.users.length).toBeLessThanOrEqual(2);
      seen.push(...page.users.map((user) => user.userId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);

    expect(seen).toEqual(full.users.map((user) => user.userId));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each([
    ["an unknown key", "?role=admin"],
    ["an unknown account type", "?accountType=root"],
    ["a malformed tenant id", "?tenantId=Not.A.Tenant"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a non-numeric limit", "?limit=ten"],
    ["a malformed cursor", "?cursor=a%20b"],
    ["a repeated key", "?accountType=tenant_admin&accountType=platform_admin"],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await call("GET", `/v1/platform/users${query}`);
    expect(response.status).toBe(400);
  });

  it("answers the opaque 404, never the 400, to a non-platform caller with a bad query", async () => {
    for (const cookie of [null, shopAdmin.cookie]) {
      const response = await call("GET", "/v1/platform/users?limit=0", { cookie, shopId: SHOP_A });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_404);
    }
  });

  it("carries no password, hash, token or secret anywhere", async () => {
    const credential = await env.DB.prepare(
      `SELECT "password" FROM "account" WHERE "userId" = ? AND "providerId" = 'credential'`,
    )
      .bind(shopAdmin.userId)
      .first<{ password: string }>();
    const session = await env.DB.prepare(
      'SELECT "token" FROM "session" WHERE "userId" = ? LIMIT 1',
    )
      .bind(shopAdmin.userId)
      .first<{ token: string }>();
    expect(credential?.password).toBeTruthy();
    expect(session?.token).toBeTruthy();

    for (const path of ["/v1/platform/users", `/v1/platform/users/${shopAdmin.userId}`]) {
      const response = await call("GET", path);
      expect(response.status).toBe(200);
      const text = await response.text();

      expect(forbiddenEntries(JSON.parse(text))).toEqual([]);
      expect(text).not.toContain(credential?.password as string);
      expect(text).not.toContain(session?.token as string);
    }
  });
});

describe("GET /v1/platform/users/:userId", () => {
  it("answers one user's directory entry", async () => {
    const response = await call("GET", `/v1/platform/users/${printOperator.userId}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ user: DirectoryUserBody }>();
    expect(Object.keys(body)).toEqual(["user"]);
    expect(Object.keys(body.user).sort()).toEqual([
      "accountType",
      "createdAt",
      "email",
      "hasPassword",
      "invite",
      "memberships",
      "name",
      "printMemberships",
      "status",
      "userId",
    ]);
    expect(body.user).toMatchObject({
      accountType: "print_operator",
      email: "print-operator@example.com",
      userId: printOperator.userId,
    });
  });

  it.each([
    ["an unknown id", "no-such-user-id"],
    ["an encoded slash", "a%2Fb"],
    ["a dot", "a.b"],
    ["a malformed escape", "%E0%A4%A"],
  ])("answers the opaque 404 for %s", async (_label, segment) => {
    const response = await call("GET", `/v1/platform/users/${segment}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(OPAQUE_404);
  });
});

describe("every identity route refuses anyone but a live platform session", () => {
  const routes = (): [string, string][] => [
    ["GET", "/v1/platform/users"],
    ["GET", `/v1/platform/users/${probeTarget.userId}`],
    ["POST", `/v1/platform/users/${probeTarget.userId}/deactivate`],
    ["POST", `/v1/platform/users/${probeTarget.userId}/reactivate`],
    ["POST", `/v1/platform/users/${probeTarget.userId}/invite`],
    ["POST", `/v1/platform/tenants/${SHOP_A}/admins/${probeTarget.userId}/revoke`],
  ];

  async function snapshot() {
    const access = await env.DB.prepare(
      "SELECT status FROM identity_access WHERE user_id = ?",
    )
      .bind(probeTarget.userId)
      .first<{ status: string }>();
    const membership = await env.DB.prepare(
      "SELECT status FROM tenant_memberships WHERE user_id = ? AND tenant_id = ?",
    )
      .bind(probeTarget.userId, SHOP_A)
      .first<{ status: string }>();
    const invites = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM identity_invites WHERE user_id = ?",
    )
      .bind(probeTarget.userId)
      .first<{ total: number }>();
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM audit_events WHERE resource_id = ? OR metadata_json LIKE ?",
    )
      .bind(probeTarget.userId, `%${probeTarget.userId}%`)
      .first<{ total: number }>();
    return { access, audits, invites, membership };
  }

  it.each([
    ["no session", () => ({ cookie: null })],
    ["a tenant-admin session naming its own shop", () => ({ cookie: shopAdmin.cookie, shopId: SHOP_A })],
    ["a suspended tenant admin", () => ({ cookie: suspendedAdmin.cookie, shopId: SHOP_B })],
    ["a print operator", () => ({ cookie: printOperator.cookie })],
  ] as const)("answers the opaque 404 to %s and changes nothing", async (_label, who) => {
    const before = await snapshot();
    for (const [method, path] of routes()) {
      const response = await call(method, path, who());
      expect(response.status, `${method} ${path}`).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_404);
    }
    await expect(snapshot()).resolves.toEqual(before);
  });

  it.each([
    ["a cross-site Origin", "https://evil.example.com"],
    ["no Origin", null],
  ] as const)("refuses every state change with %s, as the other platform routes do", async (_label, origin) => {
    const before = await snapshot();
    for (const [method, path] of routes().filter(([method]) => method === "POST")) {
      const response = await call(method, path, { origin });
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toEqual(OPAQUE_404);
    }
    await expect(snapshot()).resolves.toEqual(before);
  });

  it("reaches every handler with a platform session", async () => {
    const statuses: number[] = [];
    for (const [method, path] of routes()) {
      statuses.push((await call(method, path)).status);
    }
    // directory, read, deactivate, reactivate, invite (queued), revoke.
    expect(statuses).toEqual([200, 200, 200, 200, 202, 200]);
  });

  it("answers the opaque 404 for methods the routes do not own", async () => {
    for (const [method, path] of [
      ["HEAD", "/v1/platform/users"],
      ["DELETE", `/v1/platform/users/${probeTarget.userId}`],
      ["GET", `/v1/platform/users/${probeTarget.userId}/deactivate`],
      ["PUT", `/v1/platform/users/${probeTarget.userId}/invite`],
      ["GET", `/v1/platform/tenants/${SHOP_A}/admins/${probeTarget.userId}/revoke`],
    ] as const) {
      const response = await call(method, path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("POST /v1/platform/users (create) is unchanged by the directory GET", () => {
  it("still creates a tenant admin, who then appears in the directory", async () => {
    const created = await call("POST", "/v1/platform/users", {
      body: {
        accountType: "tenant_admin",
        email: "created-admin@example.com",
        password: PASSWORD,
      },
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ user: { accountType: string; email: string; userId: string } }>();
    expect(body.user).toEqual({
      accountType: "tenant_admin",
      email: "created-admin@example.com",
      userId: expect.any(String),
    });

    const read = await call("GET", `/v1/platform/users/${body.user.userId}`);
    await expect(read.json()).resolves.toMatchObject({
      user: { accountType: "tenant_admin", status: "active", userId: body.user.userId },
    });
  });

  it("still refuses to create a platform admin", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM identity_access WHERE account_type = 'platform_admin'",
    ).first<{ total: number }>();

    const refused = await call("POST", "/v1/platform/users", {
      body: {
        accountType: "platform_admin",
        email: "escalation@example.com",
        password: PASSWORD,
      },
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });

    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM identity_access WHERE account_type = 'platform_admin'",
      ).first<{ total: number }>(),
    ).resolves.toEqual(before);
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE "email" = ?')
        .bind("escalation@example.com")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it("still refuses a cross-site create", async () => {
    const response = await call("POST", "/v1/platform/users", {
      body: { accountType: "tenant_admin", email: "cross@example.com", password: PASSWORD },
      origin: "https://evil.example.com",
    });
    expect(response.status).toBe(404);
  });
});

describe("the directory's password and invite facts (review round 1)", () => {
  // Shaped the way the importer creates identities: a user row, and either a
  // credential account with NO password or no account at all.
  const IMPORTED_ID = "imported-3c9e1b7a-2f44-4c1e-8d0a-5b6f7e8d9c01";
  const NO_ACCOUNT_ID = "imported-7a1d2c3b-4e5f-4a6b-9c8d-0e1f2a3b4c5d";
  const HOUR_MS = 60 * 60 * 1_000;
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const tokens: string[] = [];

  function envWith(overrides: Record<PropertyKey, unknown>): Env {
    return { ...env, ...overrides } as unknown as Env;
  }

  function capturingEnv(): Env {
    return envWith({
      EMAIL_QUEUE: {
        async send(body: unknown) {
          const job = parseAuthEmailJob(body, env.AUTH_BASE_URL);
          tokens.push(new URL(job.actionUrl).pathname.split("/").at(-1) as string);
        },
      },
    });
  }

  async function read(userId: string): Promise<DirectoryUserBody> {
    const response = await call("GET", `/v1/platform/users/${userId}`);
    expect(response.status).toBe(200);
    return (await response.json<{ user: DirectoryUserBody }>()).user;
  }

  function inviteThroughRoute(userId: string): Promise<Response> {
    return worker.fetch(
      new Request(`${PLATFORM_HOST}/v1/platform/users/${userId}/invite`, {
        headers: { cookie: operator.cookie, origin: PLATFORM_HOST },
        method: "POST",
      }),
      capturingEnv(),
    );
  }

  beforeAll(async () => {
    const iso = new Date(NOW).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (?, 'Test Imported Admin', 'imported-admin@example.com', 1, ?, ?)`,
      ).bind(IMPORTED_ID, iso, iso),
      env.DB.prepare(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
         VALUES (?, ?, 'credential', ?, NULL, ?, ?)`,
      ).bind(`account-${IMPORTED_ID}`, IMPORTED_ID, IMPORTED_ID, iso, iso),
      env.DB.prepare(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (?, 'Test Accountless Admin', 'accountless-admin@example.com', 1, ?, ?)`,
      ).bind(NO_ACCOUNT_ID, iso, iso),
    ]);
    await seedAccess(IMPORTED_ID, "tenant_admin");
    await seedAccess(NO_ACCOUNT_ID, "tenant_admin");
  });

  it("says whether a usable password exists", async () => {
    await expect(read(shopAdmin.userId)).resolves.toMatchObject({ hasPassword: true, invite: null });
    await expect(read(IMPORTED_ID)).resolves.toMatchObject({ hasPassword: false, invite: null });
    await expect(read(NO_ACCOUNT_ID)).resolves.toMatchObject({ hasPassword: false, invite: null });

    const list = await (await call("GET", "/v1/platform/users?accountType=tenant_admin")).json<DirectoryBody>();
    const byId = new Map(list.users.map((user) => [user.userId, user]));
    expect(byId.get(IMPORTED_ID)?.hasPassword).toBe(false);
    expect(byId.get(shopAdmin.userId)?.hasPassword).toBe(true);
  });

  it("shows the latest invite — status and times, never its capability", async () => {
    expect((await inviteThroughRoute(IMPORTED_ID)).status).toBe(202);
    const first = (await read(IMPORTED_ID)).invite;
    expect(first).toEqual({
      createdAt: expect.stringMatching(ISO),
      expiresAt: expect.stringMatching(ISO),
      pending: true,
      status: "issued",
    });
    expect(Date.parse(first?.expiresAt as string) - Date.parse(first?.createdAt as string)).toBe(
      72 * HOUR_MS,
    );

    // A newer invite supersedes it; the directory shows the newer, live one.
    expect((await inviteThroughRoute(IMPORTED_ID)).status).toBe(202);
    const rows = await env.DB.prepare(
      `SELECT status, created_at, verification_id, delivery_id
       FROM identity_invites WHERE user_id = ? ORDER BY created_at, status`,
    )
      .bind(IMPORTED_ID)
      .all<{ created_at: string; delivery_id: string; status: string; verification_id: string }>();
    expect(rows.results.map((row) => row.status).sort()).toEqual(["issued", "superseded"]);
    const live = rows.results.find((row) => row.status === "issued");
    expect((await read(IMPORTED_ID)).invite).toMatchObject({
      createdAt: live?.created_at,
      status: "issued",
    });

    const texts = [
      await (await call("GET", `/v1/platform/users/${IMPORTED_ID}`)).text(),
      await (await call("GET", "/v1/platform/users")).text(),
    ];
    for (const text of texts) {
      expect(forbiddenEntries(JSON.parse(text))).toEqual([]);
      for (const row of rows.results) {
        expect(text).not.toContain(row.verification_id);
        expect(text).not.toContain(row.delivery_id);
      }
      for (const token of tokens) {
        expect(text).not.toContain(token);
      }
    }
  });

  it("marks an issued invite whose 72 hours have passed as expired", async () => {
    const principal = await authorizePlatformAdmin(env.DB, operator.userId);
    if (principal === null) {
      throw new Error("operator is not a platform admin");
    }
    const issued = await issueInvite(capturingEnv(), principal, NO_ACCOUNT_ID, Date.now() - 73 * HOUR_MS);
    expect(issued.status).toBe("ok");

    expect((await read(NO_ACCOUNT_ID)).invite).toEqual({
      createdAt: expect.stringMatching(ISO),
      expired: true,
      expiresAt: expect.stringMatching(ISO),
      pending: true,
      status: "issued",
    });
  });

  it("shows a revoked invite, without the expired flag, after deactivation", async () => {
    const response = await call("POST", `/v1/platform/users/${NO_ACCOUNT_ID}/deactivate`);
    expect(response.status).toBe(200);
    const { user } = await response.json<{ user: DirectoryUserBody }>();
    expect(user.invite).toEqual({
      createdAt: expect.stringMatching(ISO),
      expiresAt: expect.stringMatching(ISO),
      pending: true,
      status: "revoked",
    });
  });

  it("turns hasPassword true once the invite is used; the invite row stays issued", async () => {
    const token = tokens[1] as string;
    const reset = await worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
        body: JSON.stringify({ newPassword: "chosen-by-the-invitee-long-enough", token }),
        headers: { "content-type": "application/json", origin: "https://web.test.invalid" },
        method: "POST",
      }),
      env,
    );
    expect(reset.status).toBe(200);

    await expect(read(IMPORTED_ID)).resolves.toMatchObject({
      hasPassword: true,
      invite: { pending: false, status: "issued" },
    });
  });
});

describe("an identity created without a password, and an invite not taken up (CP5-WJ4)", () => {
  const HOUR_MS = 60 * 60 * 1_000;
  const CHOSEN = "chosen-by-the-invitee-long-enough";
  const tokens: string[] = [];

  function capturingEnv(): Env {
    return {
      ...env,
      EMAIL_QUEUE: {
        async send(body: unknown) {
          const job = parseAuthEmailJob(body, env.AUTH_BASE_URL);
          tokens.push(new URL(job.actionUrl).pathname.split("/").at(-1) as string);
        },
      },
    } as unknown as Env;
  }

  async function read(userId: string): Promise<DirectoryUserBody> {
    const response = await call("GET", `/v1/platform/users/${userId}`);
    expect(response.status).toBe(200);
    return (await response.json<{ user: DirectoryUserBody }>()).user;
  }

  async function listed(userId: string): Promise<DirectoryUserBody | undefined> {
    const response = await call("GET", "/v1/platform/users?accountType=tenant_admin&limit=100");
    expect(response.status).toBe(200);
    return (await response.json<DirectoryBody>()).users.find((user) => user.userId === userId);
  }

  function invite(userId: string): Promise<Response> {
    return worker.fetch(
      new Request(`${PLATFORM_HOST}/v1/platform/users/${userId}/invite`, {
        headers: { cookie: operator.cookie, origin: PLATFORM_HOST },
        method: "POST",
      }),
      capturingEnv(),
    );
  }

  async function signInAttempt(email: string, password: string): Promise<Response> {
    await drainAuthLimiter();
    return worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
        method: "POST",
      }),
      env,
    );
  }

  function usePasswordLink(token: string): Promise<Response> {
    return worker.fetch(
      new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
        body: JSON.stringify({ newPassword: CHOSEN, token }),
        headers: { "content-type": "application/json", origin: "https://web.test.invalid" },
        method: "POST",
      }),
      env,
    );
  }

  async function sessions(userId: string): Promise<number> {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?')
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function create(body: Record<string, unknown>): Promise<string> {
    const response = await call("POST", "/v1/platform/users", { body });
    expect(response.status).toBe(201);
    const { user } = await response.json<{ user: { accountType: string; email: string; userId: string } }>();
    expect(user).toEqual({ accountType: body.accountType, email: body.email, userId: expect.any(String) });
    return user.userId;
  }

  it("is created password-less in one step: hasPassword false, and no password signs it in", async () => {
    const email = "credential-less@example.com";
    const userId = await create({ accountType: "tenant_admin", email });

    // One credential account, with no password; the identity complete.
    const accounts = await env.DB.prepare(
      `SELECT "providerId" AS provider, "accountId" AS account, ("password" IS NULL) AS no_password
       FROM "account" WHERE "userId" = ?`,
    )
      .bind(userId)
      .all<{ account: string; no_password: number; provider: string }>();
    expect(accounts.results).toEqual([{ account: userId, no_password: 1, provider: "credential" }]);
    await expect(
      env.DB.prepare("SELECT account_type, status FROM identity_access WHERE user_id = ?").bind(userId).first(),
    ).resolves.toEqual({ account_type: "tenant_admin", status: "active" });

    await expect(read(userId)).resolves.toMatchObject({
      email,
      hasPassword: false,
      invite: null,
      name: "credential-less",
      status: "active",
    });
    expect((await listed(userId))?.hasPassword).toBe(false);

    for (const password of [PASSWORD, "x".repeat(64), "null", "undefined", "00000000"]) {
      expect((await signInAttempt(email, password)).status, password).toBe(401);
    }
    expect((await signInAttempt(email, "")).status).not.toBe(200);
    expect(await sessions(userId)).toBe(0);
  });

  it("writes the rows a sign-up writes, with the same storage types, minus the password", async () => {
    const userId = await create({ accountType: "tenant_admin", email: "shape-check@example.com" });
    const shape = (id: string) =>
      env.DB.prepare(
        `SELECT typeof(u."emailVerified") AS verified, u."emailVerified" AS verified_value,
           typeof(u."createdAt") AS user_created, typeof(u."updatedAt") AS user_updated,
           typeof(c."createdAt") AS account_created, typeof(c."updatedAt") AS account_updated,
           (c."updatedAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', c."updatedAt")) AS account_updated_iso,
           (u."createdAt" IS strftime('%Y-%m-%dT%H:%M:%fZ', u."createdAt")) AS user_created_iso,
           length(u."id") AS id_length, length(c."id") AS account_id_length
         FROM "user" AS u JOIN "account" AS c ON c."userId" = u."id" AND c."providerId" = 'credential'
         WHERE u."id" = ?`,
      )
        .bind(id)
        .first();
    expect(await shape(userId)).toEqual(await shape(shopAdmin.userId));
  });

  it("gets its password from the invite's link; then it signs in, and the invite reads taken up", async () => {
    const email = "credential-less-accepts@example.com";
    const userId = await create({ accountType: "tenant_admin", email });

    expect((await invite(userId)).status).toBe(202);
    await expect(read(userId)).resolves.toMatchObject({
      hasPassword: false,
      invite: { pending: true, status: "issued" },
    });

    expect((await usePasswordLink(tokens.at(-1) as string)).status).toBe(200);
    expect((await signInAttempt(email, CHOSEN)).status).toBe(200);
    expect((await signInAttempt(email, PASSWORD)).status).toBe(401);
    await expect(read(userId)).resolves.toMatchObject({
      hasPassword: true,
      invite: { pending: false, status: "issued" },
    });
    expect((await listed(userId))?.invite?.pending).toBe(false);
  });

  it("reads a password written BEFORE the latest invite (the earlier console's throwaway) as not chosen: the invite stays pending, expired or not, until a link is used", async () => {
    // The earlier console flow: created WITH a password nobody knew, invited
    // after; the invite expired unused.
    const email = "throwaway-era@example.com";
    const userId = await create({ accountType: "tenant_admin", email, password: "x".repeat(96) });
    const principal = await authorizePlatformAdmin(env.DB, operator.userId);
    if (principal === null) {
      throw new Error("operator is not a platform admin");
    }
    const invitedAt = Date.now() - 73 * HOUR_MS;
    expect((await issueInvite(capturingEnv(), principal, userId, invitedAt)).status).toBe("ok");
    await env.DB.prepare(`UPDATE "account" SET "updatedAt" = ?, "createdAt" = ? WHERE "userId" = ?`)
      .bind(new Date(invitedAt - 60_000).toISOString(), new Date(invitedAt - 60_000).toISOString(), userId)
      .run();

    await expect(read(userId)).resolves.toMatchObject({
      hasPassword: true,
      invite: { expired: true, pending: true, status: "issued" },
    });
    expect((await listed(userId))?.invite).toMatchObject({ expired: true, pending: true });

    // The operator re-invites (the server allows any active admin); the new
    // invite is live and still pending.
    expect((await invite(userId)).status).toBe(202);
    const live = (await read(userId)).invite;
    expect(live).toMatchObject({ pending: true, status: "issued" });
    expect(live?.expired).toBeUndefined();

    // Used: the password is the person's own.
    expect((await usePasswordLink(tokens.at(-1) as string)).status).toBe(200);
    expect((await signInAttempt(email, CHOSEN)).status).toBe(200);
    await expect(read(userId)).resolves.toMatchObject({
      hasPassword: true,
      invite: { pending: false },
    });
  });

  it("keeps a password set by its owner AFTER an invite as the owner's", async () => {
    // A signed-up user (a password of their own) who later received an invite
    // and then used it: pending false. One who has NOT used it: pending true —
    // offering the link again is harmless.
    const owner = await signUp("owns-a-password@example.com", "Test Owner");
    await seedAccess(owner.userId, "tenant_admin");
    await expect(read(owner.userId)).resolves.toMatchObject({ hasPassword: true, invite: null });
    const principal = await authorizePlatformAdmin(env.DB, operator.userId);
    if (principal === null) {
      throw new Error("operator is not a platform admin");
    }
    expect((await issueInvite(capturingEnv(), principal, owner.userId, Date.now())).status).toBe("ok");
    await expect(read(owner.userId)).resolves.toMatchObject({
      hasPassword: true,
      invite: { pending: true },
    });
    expect((await usePasswordLink(tokens.at(-1) as string)).status).toBe(200);
    await expect(read(owner.userId)).resolves.toMatchObject({
      hasPassword: true,
      invite: { pending: false },
    });
  });
});
