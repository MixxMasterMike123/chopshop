import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { passwordResetCallbackUrl, resetPageOrigin } from "../src/auth/password-reset";
import { parseAuthEmailJob } from "../src/email/auth-email-job";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { parseCanonicalOrigins } from "../src/lib/origins";
import { ACTING_AS_TTL_MS } from "../src/platform/acting-as";
import { issueInvite } from "../src/platform/invites";
import { TENANT_ADMIN_CAP } from "../src/platform/tenant-members";
import {
  MEMBER_INVITE_EMAIL_LIMIT,
  MEMBER_INVITE_TENANT_LIMIT,
} from "../src/routes/admin-members";

/**
 * CP5-WC — a shop's own admins (D100): GET /v1/admin/members,
 * POST /v1/admin/members, POST /v1/admin/members/:userId/revoke.
 * The invite job is captured through an injected EMAIL_QUEUE and its link is
 * followed through the real mounted reset endpoints.
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const ADMIN_HOST = "https://admin.members.example.com";
const TEST_ORIGINS = parseCanonicalOrigins(env.CANONICAL_ORIGINS);
const ADMIN_RESET_PAGE = passwordResetCallbackUrl(TEST_ORIGINS, "admin");
const RESET_ORIGIN = resetPageOrigin(TEST_ORIGINS, "admin");
const SHOP = "members-shop";
const OTHER = "members-other";
const FULL = "members-full";
const LONE = "members-lone";
const PAIR = "members-pair";
const NEAR = "members-near";
const NOW = 1_789_000_000_000;
const PASSWORD = "test-password-long-enough";
const NEW_PASSWORD = "chosen-by-the-invitee-long-enough";
const MEMBER_KEYS = ["email", "invited", "joinedAt", "name", "self", "status", "userId"];

interface Person {
  cookie: string;
  email: string;
  userId: string;
}

let owner: Person;
let colleague: Person;
let foreignAdmin: Person;
let operator: Person;
let printOp: Person;
let suspended: Person;
let loneAdmin: Person;
let pairA: Person;
let pairB: Person;
let operatorGrantId: string;

interface CapturedQueue {
  queue: Queue;
  sent: unknown[];
}

function captureQueue(options: { fail?: boolean } = {}): CapturedQueue {
  const sent: unknown[] = [];
  const queue = {
    async send(body: unknown) {
      if (options.fail === true) {
        throw new Error("queue unavailable");
      }
      sent.push(body);
    },
    async sendBatch() {
      throw new Error("not used");
    },
  } as unknown as Queue;
  return { queue, sent };
}

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

async function signInResponse(email: string, password = PASSWORD): Promise<Response> {
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

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
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
  const signedIn = await signInResponse(email);
  expect(signedIn.status).toBe(200);
  return { cookie: cookieOf(signedIn), email, userId: body.user.id };
}

async function seedTenant(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Test ${tenantId}`, NOW, NOW)
    .run();
}

async function seedAccess(userId: string, accountType: string, status = "active") {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, accountType, status, NOW, NOW)
    .run();
}

async function seedMembership(userId: string, tenantId: string, createdAt = NOW): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), tenantId, userId, createdAt, createdAt)
    .run();
}

/** A user row + identity + membership written with SQL (no credential). */
async function seedBareAdmin(tenantId: string, index: number, status = "active"): Promise<string> {
  const id = `seeded-${tenantId}-${index}`;
  const iso = new Date(NOW).toISOString();
  await env.DB.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, `Test Seeded ${index}`, `${id}@example.com`, iso, iso)
    .run();
  await seedAccess(id, "tenant_admin", status);
  await seedMembership(id, tenantId);
  return id;
}

async function grantActingAs(userId: string, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, tenantId, new Date(now).toISOString(), new Date(now + ACTING_AS_TTL_MS).toISOString())
    .run();
  return id;
}

interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  env?: Env;
  method?: string;
  origin?: string | null;
  rawBody?: string;
  shop?: string | null;
}

function call(path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  const cookie = options.cookie === undefined ? owner.cookie : options.cookie;
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  const shop = options.shop === undefined ? SHOP : options.shop;
  if (shop !== null) {
    headers.set("x-shop-id", shop);
  }
  const origin = options.origin === undefined ? (method === "GET" ? null : ADMIN_HOST) : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return worker.fetch(new Request(`${ADMIN_HOST}${path}`, { body, headers, method }), options.env ?? env);
}

function list(options: CallOptions = {}) {
  return call("/v1/admin/members", options);
}

function add(body: unknown, options: CallOptions = {}) {
  return call("/v1/admin/members", { body, method: "POST", ...options });
}

function revoke(userId: string, options: CallOptions = {}) {
  return call(`/v1/admin/members/${userId}/revoke`, { method: "POST", ...options });
}

async function expectOpaque404(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: { code: "not_found", message: "Route not found" },
  });
}

async function expectRefusal(response: Response, code: string): Promise<void> {
  expect(response.status).toBe(409);
  const body = await response.json<{ error: { code: string; message: string } }>();
  expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  expect(body.error.code).toBe(code);
}

interface MemberBody {
  email: string;
  invited: boolean;
  joinedAt: string;
  name: string;
  self: boolean;
  status: string;
  userId: string;
}

async function members(options: CallOptions = {}): Promise<MemberBody[]> {
  const response = await list(options);
  expect(response.status).toBe(200);
  return (await response.json<{ members: MemberBody[] }>()).members;
}

async function membershipStatus(userId: string, tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT status FROM tenant_memberships WHERE user_id = ? AND tenant_id = ? AND role = 'admin'`,
  )
    .bind(userId, tenantId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

function tokenOf(job: AuthEmailJob): string {
  return new URL(job.actionUrl).pathname.split("/").at(-1) as string;
}

async function setPassword(token: string): Promise<Response> {
  return worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
      body: JSON.stringify({ newPassword: NEW_PASSWORD, token }),
      headers: { "content-type": "application/json", origin: RESET_ORIGIN },
      method: "POST",
    }),
    env,
  );
}

beforeAll(async () => {
  for (const tenant of [SHOP, OTHER, FULL, LONE, PAIR, NEAR]) {
    await seedTenant(tenant);
  }

  owner = await signUp("members-owner@example.com", "Test Owner");
  colleague = await signUp("members-colleague@example.com", "Test Colleague");
  foreignAdmin = await signUp("members-foreign@example.com", "Test Foreign Admin");
  operator = await signUp("members-operator@example.com", "Test Operator");
  printOp = await signUp("members-print@example.com", "Test Printer");
  suspended = await signUp("members-suspended@example.com", "Test Suspended");
  loneAdmin = await signUp("members-lone@example.com", "Test Lone");
  pairA = await signUp("members-pair-a@example.com", "Test Pair A");
  pairB = await signUp("members-pair-b@example.com", "Test Pair B");

  for (const person of [owner, colleague, foreignAdmin, loneAdmin, pairA, pairB]) {
    await seedAccess(person.userId, "tenant_admin");
  }
  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(printOp.userId, "print_operator");
  await seedAccess(suspended.userId, "tenant_admin", "suspended");

  await seedMembership(owner.userId, SHOP, NOW);
  await seedMembership(colleague.userId, SHOP, NOW + 1);
  await seedMembership(foreignAdmin.userId, OTHER);
  await seedMembership(owner.userId, OTHER);
  await seedMembership(loneAdmin.userId, LONE);
  await seedMembership(pairA.userId, PAIR);
  await seedMembership(pairB.userId, PAIR);

  // FULL: the cap reached — owner + (cap - 1) seeded admins who count, plus
  // one with a suspended identity who does not.
  await seedMembership(owner.userId, FULL);
  for (let index = 1; index < TENANT_ADMIN_CAP; index += 1) {
    await seedBareAdmin(FULL, index);
  }
  await seedBareAdmin(FULL, 99, "suspended");
  // NEAR: one place left.
  await seedMembership(owner.userId, NEAR);
  for (let index = 1; index < TENANT_ADMIN_CAP - 1; index += 1) {
    await seedBareAdmin(NEAR, index);
  }

  operatorGrantId = await grantActingAs(operator.userId, SHOP);
  await grantActingAs(operator.userId, LONE);
  await grantActingAs(operator.userId, PAIR);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
});

describe("refusals: who may reach the surface", () => {
  it("answers the opaque 404 without a session, on every route", async () => {
    await expectOpaque404(await list({ cookie: null }));
    await expectOpaque404(
      await add({ email: "nobody@example.com", name: "Test Nobody" }, { cookie: null }),
    );
    await expectOpaque404(await revoke(colleague.userId, { cookie: null }));
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("active");
  });

  it("answers the opaque 404 for a shop the session does not administer, or none named", async () => {
    // A tenant admin of another shop naming this one.
    await expectOpaque404(await list({ cookie: foreignAdmin.cookie }));
    await expectOpaque404(
      await add({ email: "x1@example.com", name: "Test X" }, { cookie: foreignAdmin.cookie }),
    );
    await expectOpaque404(await revoke(colleague.userId, { cookie: foreignAdmin.cookie }));
    // No shop named; a malformed one; a platform user with no grant on it.
    await expectOpaque404(await list({ shop: null }));
    await expectOpaque404(await list({ shop: "Members-Shop" }));
    await expectOpaque404(await list({ cookie: operator.cookie, shop: OTHER }));
    // A print operator.
    await expectOpaque404(await list({ cookie: printOp.cookie }));
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("active");
    await expect(
      countRows(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'x1@example.com'`),
    ).resolves.toBe(0);
  });

  it("refuses a cross-origin or origin-less state change before the body is read", async () => {
    for (const origin of ["https://evil.example.com", null, "null"]) {
      await expectOpaque404(
        await add({ email: "cross@example.com", name: "Test Cross" }, { origin }),
      );
      await expectOpaque404(await revoke(colleague.userId, { origin }));
    }
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("active");
    await expect(
      countRows(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'cross@example.com'`),
    ).resolves.toBe(0);
  });

  it("answers the opaque 404 to a wrong method", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(await call("/v1/admin/members", { method }));
      await expectOpaque404(await call(`/v1/admin/members/${colleague.userId}/revoke`, { method }));
    }
    await expectOpaque404(await call(`/v1/admin/members/${colleague.userId}/revoke`));
    await expectOpaque404(await call(`/v1/admin/members/${colleague.userId}`));
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("active");
  });

  it("answers the opaque 404 to a malformed user id, an unknown one, and another shop's admin", async () => {
    for (const raw of ["a.b", "%2E%2E", "a%2Fb", "%ZZ", "x".repeat(129), "%2574"]) {
      await expectOpaque404(await revoke(raw));
    }
    await expectOpaque404(await revoke("unknown-user-id"));
    await expectOpaque404(await revoke(foreignAdmin.userId));
    expect(await membershipStatus(foreignAdmin.userId, OTHER)).toBe("active");
  });

  it("is dark (opaque 404) for the invite while the invite mail is not configured", async () => {
    await expectOpaque404(
      await add(
        { email: "dark@example.com", name: "Test Dark" },
        { env: envWith({ EMAIL_QUEUE: undefined }) },
      ),
    );
    await expect(
      countRows(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'dark@example.com'`),
    ).resolves.toBe(0);
  });
});

describe("refusals: the invite", () => {
  it("answers 400 to a malformed body, writing nothing", async () => {
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    const bodies: unknown[] = [
      null,
      [],
      "x",
      {},
      { email: "bad-body@example.com" },
      { name: "Test Name" },
      { email: "not-an-address", name: "Test Name" },
      { email: "two@@example.com", name: "Test Name" },
      { email: "sp ace@example.com", name: "Test Name" },
      { email: 7, name: "Test Name" },
      { email: "bad-body@example.com", name: "" },
      { email: "bad-body@example.com", name: "   " },
      { email: "bad-body@example.com", name: " Test Padded" },
      { email: "bad-body@example.com", name: "Test\u0000Name" },
      { email: "bad-body@example.com", name: "x".repeat(101) },
      { email: "bad-body@example.com", name: "Test Name", role: "admin" },
      { email: "bad-body@example.com", name: "Test Name", tenantId: OTHER },
    ];
    for (const body of bodies) {
      const response = await add(body, options);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await add(undefined, { ...options, rawBody: "{not json" })).status).toBe(400);
    expect(captured.sent).toHaveLength(0);
    await expect(
      countRows(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'bad-body@example.com'`),
    ).resolves.toBe(0);
  });

  it("refuses a platform admin, a print operator, a suspended identity and an identity-less user with ONE answer", async () => {
    const orphanIso = new Date(NOW).toISOString();
    await env.DB.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('members-orphan', 'Test Orphan', 'members-orphan@example.com', 1, ?, ?)`,
    )
      .bind(orphanIso, orphanIso)
      .run();

    const captured = captureQueue();
    const bodies: string[] = [];
    for (const email of [operator.email, printOp.email, suspended.email, "members-orphan@example.com"]) {
      const response = await add(
        { email, name: "Test Probe" },
        { env: envWith({ EMAIL_QUEUE: captured.queue }) },
      );
      expect(response.status).toBe(409);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({
      error: { code: "not_addable", message: "The address cannot be added to this shop" },
    });
    expect(captured.sent).toHaveLength(0);
    for (const userId of [operator.userId, printOp.userId, suspended.userId, "members-orphan"]) {
      expect(await membershipStatus(userId, SHOP)).toBeNull();
    }
    await expect(
      env.DB.prepare(`SELECT account_type, status FROM identity_access WHERE user_id = ?`)
        .bind(suspended.userId)
        .first(),
    ).resolves.toEqual({ account_type: "tenant_admin", status: "suspended" });
  });

  it("refuses an existing active member (casing is the same address)", async () => {
    const captured = captureQueue();
    await expectRefusal(
      await add(
        { email: colleague.email.toUpperCase(), name: "Test Again" },
        { env: envWith({ EMAIL_QUEUE: captured.queue }) },
      ),
      "already_member",
    );
    // Yourself too.
    await expectRefusal(
      await add(
        { email: owner.email, name: "Test Me" },
        { env: envWith({ EMAIL_QUEUE: captured.queue }) },
      ),
      "already_member",
    );
    expect(captured.sent).toHaveLength(0);
  });

  it("refuses over the cap with a reason, creating no identity; a suspended identity does not count", async () => {
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM tenant_memberships WHERE tenant_id = ? AND status = 'active'`,
        FULL,
      ),
    ).resolves.toBe(TENANT_ADMIN_CAP + 1);

    const captured = captureQueue();
    const response = await add(
      { email: "over-cap@example.com", name: "Test Over" },
      { env: envWith({ EMAIL_QUEUE: captured.queue }), shop: FULL },
    );
    await expectRefusal(response.clone(), "member_limit");
    expect((await response.json<{ error: { message: string } }>()).error.message).toContain(
      String(TENANT_ADMIN_CAP),
    );
    // A known address of another shop: the same refusal.
    await expectRefusal(
      await add(
        { email: foreignAdmin.email, name: "Test Foreign" },
        { env: envWith({ EMAIL_QUEUE: captured.queue }), shop: FULL },
      ),
      "member_limit",
    );
    expect(captured.sent).toHaveLength(0);
    await expect(
      countRows(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = 'over-cap@example.com'`),
    ).resolves.toBe(0);
    expect(await membershipStatus(foreignAdmin.userId, FULL)).toBeNull();

    // The list shows the suspended one as such; the cap counts the others.
    const listed = await members({ shop: FULL });
    expect(listed).toHaveLength(TENANT_ADMIN_CAP + 1);
    expect(listed.filter((member) => member.status === "suspended")).toHaveLength(1);
  });

  it("lets only one of two concurrent invites take the last place; the loser's new identity is left password-less", async () => {
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }), shop: NEAR };
    const emails = ["race-one@example.com", "race-two@example.com"];
    const responses = await Promise.all(
      emails.map((email) => add({ email, name: "Test Race" }, options)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409) as Response;
    await expectRefusal(loser, "member_limit");
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM tenant_memberships AS m
         JOIN identity_access AS a ON a.user_id = m.user_id
         WHERE m.tenant_id = ? AND m.status = 'active' AND a.status = 'active'`,
        NEAR,
      ),
    ).resolves.toBe(TENANT_ADMIN_CAP);
    expect(captured.sent).toHaveLength(1);
    // Whatever identity the loser created can sign in with nothing.
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM "account" AS c JOIN "user" AS u ON u."id" = c."userId"
         WHERE u."email" IN (?, ?) AND c."password" IS NOT NULL`,
        ...emails,
      ),
    ).resolves.toBe(0);
  });

  it("rate-limits per recipient address (across shops) and per shop", async () => {
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    for (let attempt = 0; attempt < MEMBER_INVITE_EMAIL_LIMIT; attempt += 1) {
      expect((await add({ email: colleague.email, name: "Test Limit" }, options)).status).toBe(409);
    }
    const limited = await add({ email: colleague.email, name: "Test Limit" }, options);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // The address bucket holds in another shop too.
    expect(
      (
        await add(
          { email: colleague.email, name: "Test Limit" },
          { ...options, cookie: owner.cookie, shop: OTHER },
        )
      ).status,
    ).toBe(429);

    await env.DB.prepare("DELETE FROM rate_limit_windows").run();
    for (let attempt = 0; attempt < MEMBER_INVITE_TENANT_LIMIT; attempt += 1) {
      expect((await add({ email: 1 }, options)).status).toBe(400);
    }
    expect((await add({ email: 1 }, options)).status).toBe(429);
    // Another shop keeps its own allowance.
    expect((await add({ email: 1 }, { ...options, shop: OTHER })).status).toBe(400);
    expect(captured.sent).toHaveLength(0);
  });
});

describe("refusals: the revoke", () => {
  it("refuses revoking yourself", async () => {
    await expectRefusal(await revoke(owner.userId), "cannot_revoke_self");
    expect(await membershipStatus(owner.userId, SHOP)).toBe("active");
  });

  it("refuses revoking the last active admin, also for an acting-as operator", async () => {
    await expectRefusal(
      await revoke(loneAdmin.userId, { cookie: operator.cookie, shop: LONE }),
      "last_admin",
    );
    expect(await membershipStatus(loneAdmin.userId, LONE)).toBe("active");
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'tenant.admin_revoke'`,
        LONE,
      ),
    ).resolves.toBe(0);
  });

  it("lets only one of two concurrent revokes of the last two admins through", async () => {
    const [first, second] = await Promise.all([
      revoke(pairA.userId, { cookie: operator.cookie, shop: PAIR }),
      revoke(pairB.userId, { cookie: operator.cookie, shop: PAIR }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    await expectRefusal(refused, "last_admin");
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM tenant_memberships
         WHERE tenant_id = ? AND role = 'admin' AND status = 'active'`,
        PAIR,
      ),
    ).resolves.toBe(1);
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'tenant.admin_revoke'`,
        PAIR,
      ),
    ).resolves.toBe(1);
  });
});

describe("the list", () => {
  it("lists this shop's active admins, oldest first, with named fields only", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ members: MemberBody[] }>();
    expect(Object.keys(body)).toEqual(["members"]);
    const ours = body.members.filter((member) =>
      [owner.userId, colleague.userId].includes(member.userId),
    );
    expect(ours).toEqual([
      {
        email: owner.email,
        invited: false,
        joinedAt: new Date(NOW).toISOString(),
        name: "Test Owner",
        self: true,
        status: "active",
        userId: owner.userId,
      },
      {
        email: colleague.email,
        invited: false,
        joinedAt: new Date(NOW + 1).toISOString(),
        name: "Test Colleague",
        self: false,
        status: "active",
        userId: colleague.userId,
      },
    ]);
    for (const member of body.members) {
      expect(Object.keys(member).sort()).toEqual(MEMBER_KEYS);
    }
    // Nothing of the other shop: its admin is absent, and nothing names it.
    const text = JSON.stringify(body);
    expect(text).not.toContain(foreignAdmin.userId);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain("tenant_admin");
  });

  it("serves an acting-as operator, who is not listed and is never `self`", async () => {
    const listed = await members({ cookie: operator.cookie });
    expect(listed.map((member) => member.userId)).not.toContain(operator.userId);
    expect(listed.every((member) => !member.self)).toBe(true);
  });
});

describe("the invite", () => {
  it("CP9-OB: with no mail account the person is added and invited, and the answer says no mail can leave", async () => {
    const captured = captureQueue();
    const response = await add(
      { email: "no-mail-yet@example.com", name: "Test No Mail" },
      { env: envWith({ EMAIL_QUEUE: captured.queue, RESEND_API_KEY: undefined }) },
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ mailConfigured: boolean; member: MemberBody }>();
    expect(Object.keys(body).sort()).toEqual(["mailConfigured", "member"]);
    expect(body.mailConfigured).toBe(false);
    expect(captured.sent).toHaveLength(1);
  });

  it("creates a password-less tenant admin, grants the membership, and mails a link landing on the admin origin", async () => {
    const captured = captureQueue();
    const email = "new-person@example.com";
    const response = await add(
      { email: "New-Person@Example.com", name: "Test New Person" },
      { env: envWith({ EMAIL_QUEUE: captured.queue }) },
    );
    expect(response.status).toBe(201);
    const { mailConfigured, member } = await response.json<{ mailConfigured: boolean; member: MemberBody }>();
    // CP9-OB: whether the mail can leave (the test env has a mail account).
    expect(mailConfigured).toBe(true);
    expect(Object.keys(member).sort()).toEqual(MEMBER_KEYS);
    expect(member).toMatchObject({
      email,
      invited: true,
      name: "Test New Person",
      self: false,
      status: "active",
    });

    // The identity: a tenant admin, active, with no usable password.
    await expect(
      env.DB.prepare(`SELECT account_type, status FROM identity_access WHERE user_id = ?`)
        .bind(member.userId)
        .first(),
    ).resolves.toEqual({ account_type: "tenant_admin", status: "active" });
    await expect(
      env.DB.prepare(
        `SELECT "password" FROM "account" WHERE "userId" = ? AND "providerId" = 'credential'`,
      )
        .bind(member.userId)
        .first(),
    ).resolves.toEqual({ password: null });
    await expect(
      env.DB.prepare(`SELECT "name", "email" FROM "user" WHERE "id" = ?`).bind(member.userId).first(),
    ).resolves.toEqual({ email, name: "Test New Person" });
    expect(await membershipStatus(member.userId, SHOP)).toBe("active");
    expect((await signInResponse(email, PASSWORD)).status).toBe(401);

    // The mail: one invite job, the link on the admin surface's reset page.
    expect(captured.sent).toHaveLength(1);
    const job = parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL);
    expect(job.recipient).toBe(email);
    expect("variant" in job ? job.variant : null).toBe("invite");
    const link = new URL(job.actionUrl);
    expect(link.searchParams.get("callbackURL")).toBe(ADMIN_RESET_PAGE);
    expect(new URL(ADMIN_RESET_PAGE).origin).toBe(TEST_ORIGINS?.admin);
    expect(job.actionUrl).not.toContain("members.example.com");
    const text = JSON.stringify(member);
    expect(text).not.toContain(tokenOf(job));

    // Audited: the grant in its own batch (actor, shop, no address).
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json FROM audit_events
       WHERE tenant_id = ? AND action = 'tenant.admin_grant'
         AND json_extract(metadata_json, '$.userId') = ?`,
    )
      .bind(SHOP, member.userId)
      .first<{ actor_user_id: string; metadata_json: string }>();
    expect(audit?.actor_user_id).toBe(owner.userId);
    expect(JSON.parse(audit?.metadata_json as string)).toMatchObject({
      newIdentity: true,
      surface: "admin",
      userId: member.userId,
    });
    expect(audit?.metadata_json).not.toContain(email);
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'platform.user_invite' AND resource_id = ?`,
        member.userId,
      ),
    ).resolves.toBe(1);

    // Listed as invited until the link is used.
    const before = (await members()).find((entry) => entry.userId === member.userId);
    expect(before).toMatchObject({ invited: true, name: "Test New Person" });

    expect((await setPassword(tokenOf(job))).status).toBe(200);
    const signedIn = await signInResponse(email, NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
    const listedByNewcomer = await members({ cookie: cookieOf(signedIn) });
    expect(listedByNewcomer.find((entry) => entry.userId === member.userId)).toMatchObject({
      invited: false,
      self: true,
    });
  });

  it("adds an admin of ANOTHER shop as a second membership, answering exactly as for a new address", async () => {
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    const known = await add({ email: foreignAdmin.email, name: "Test Given Name" }, options);
    const fresh = await add({ email: "never-seen@example.com", name: "Test Given Name" }, options);
    expect(known.status).toBe(201);
    expect(fresh.status).toBe(201);
    const knownMember = (await known.json<{ member: MemberBody }>()).member;
    const freshMember = (await fresh.json<{ member: MemberBody }>()).member;

    // Same keys, same values except the address and the id; the time is the
    // request's, never the stored creation time.
    const normal = (member: MemberBody) => ({
      ...member,
      email: "",
      joinedAt: typeof member.joinedAt,
      userId: typeof member.userId,
    });
    expect(normal(knownMember)).toEqual(normal(freshMember));
    expect(knownMember).toMatchObject({ invited: true, name: "Test Given Name" });
    expect(Date.parse(knownMember.joinedAt)).toBeGreaterThan(NOW);

    // The known person keeps their own name, password and other shop.
    expect(knownMember.userId).toBe(foreignAdmin.userId);
    await expect(
      env.DB.prepare(`SELECT "name" FROM "user" WHERE "id" = ?`).bind(foreignAdmin.userId).first(),
    ).resolves.toEqual({ name: "Test Foreign Admin" });
    expect(await membershipStatus(foreignAdmin.userId, OTHER)).toBe("active");
    expect(await membershipStatus(foreignAdmin.userId, SHOP)).toBe("active");
    expect((await signInResponse(foreignAdmin.email, PASSWORD)).status).toBe(200);
    // Only the password-less newcomer was mailed.
    expect(captured.sent).toHaveLength(1);
    expect(parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL).recipient).toBe(
      "never-seen@example.com",
    );

    // The person now reaches this shop with the session they already had.
    expect((await list({ cookie: foreignAdmin.cookie })).status).toBe(200);
  });

  it("answers 503 when the mail cannot be queued; the membership stands", async () => {
    const response = await add(
      { email: "queue-down@example.com", name: "Test Queue Down" },
      { env: envWith({ EMAIL_QUEUE: captureQueue({ fail: true }).queue }) },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "email_unavailable", message: "The invite email could not be queued" },
    });
    const listed = await members();
    expect(listed.find((member) => member.email === "queue-down@example.com")).toMatchObject({
      invited: true,
    });
  });

  it("lets an acting-as operator invite, audited with the grant id", async () => {
    const captured = captureQueue();
    const response = await add(
      { email: "by-operator@example.com", name: "Test By Operator" },
      { cookie: operator.cookie, env: envWith({ EMAIL_QUEUE: captured.queue }) },
    );
    expect(response.status).toBe(201);
    const { member } = await response.json<{ member: MemberBody }>();
    expect(captured.sent).toHaveLength(1);
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json FROM audit_events
       WHERE tenant_id = ? AND action = 'tenant.admin_grant'
         AND json_extract(metadata_json, '$.userId') = ?`,
    )
      .bind(SHOP, member.userId)
      .first<{ actor_user_id: string; metadata_json: string }>();
    expect(audit?.actor_user_id).toBe(operator.userId);
    expect(JSON.parse(audit?.metadata_json as string)).toMatchObject({
      actingAsGrantId: operatorGrantId,
    });
  });
});

describe("the revoke", () => {
  it("revokes this shop's membership only; the person's next request here is refused and /v1/me drops the shop", async () => {
    // Colleague administers SHOP and (granted here) OTHER.
    await seedMembership(colleague.userId, OTHER);

    const response = await revoke(colleague.userId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: { userId: colleague.userId } });
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("revoked");
    expect(await membershipStatus(colleague.userId, OTHER)).toBe("active");

    // The same session: refused here, still served in the other shop.
    await expectOpaque404(await list({ cookie: colleague.cookie }));
    expect((await list({ cookie: colleague.cookie, shop: OTHER })).status).toBe(200);
    const me = await worker.fetch(
      new Request(`${ADMIN_HOST}/v1/me`, { headers: { cookie: colleague.cookie } }),
      env,
    );
    expect(me.status).toBe(200);
    const tenants = (
      await me.json<{ memberships: Array<{ tenantId: string }> }>()
    ).memberships.map((membership) => membership.tenantId);
    expect(tenants).not.toContain(SHOP);
    expect(tenants).toContain(OTHER);

    // No longer listed; a second revoke is the opaque 404.
    expect((await members()).map((member) => member.userId)).not.toContain(colleague.userId);
    await expectOpaque404(await revoke(colleague.userId));

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, resource_type, metadata_json FROM audit_events
       WHERE tenant_id = ? AND action = 'tenant.admin_revoke'
         AND json_extract(metadata_json, '$.userId') = ?`,
    )
      .bind(SHOP, colleague.userId)
      .first<{ actor_user_id: string; metadata_json: string; resource_type: string }>();
    expect(audit).toMatchObject({ actor_user_id: owner.userId, resource_type: "tenant_membership" });
    expect(JSON.parse(audit?.metadata_json as string).actingAsGrantId).toBeUndefined();
  });

  it("re-adds a revoked admin by re-activating the row, without a mail (they have a password)", async () => {
    const captured = captureQueue();
    const response = await add(
      { email: colleague.email, name: "Test Colleague" },
      { env: envWith({ EMAIL_QUEUE: captured.queue }) },
    );
    expect(response.status).toBe(201);
    expect(await membershipStatus(colleague.userId, SHOP)).toBe("active");
    expect(captured.sent).toHaveLength(0);
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?`,
        SHOP,
        colleague.userId,
      ),
    ).resolves.toBe(1);
    await expect(
      countRows(
        `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'tenant.admin_reactivate'
           AND json_extract(metadata_json, '$.userId') = ?`,
        SHOP,
        colleague.userId,
      ),
    ).resolves.toBe(1);
    expect((await list({ cookie: colleague.cookie })).status).toBe(200);
  });

  it("lets an acting-as operator revoke, audited with the grant id", async () => {
    const response = await revoke(colleague.userId, { cookie: operator.cookie });
    expect(response.status).toBe(200);
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json FROM audit_events
       WHERE tenant_id = ? AND action = 'tenant.admin_revoke' AND actor_user_id = ?`,
    )
      .bind(SHOP, operator.userId)
      .first<{ actor_user_id: string; metadata_json: string }>();
    expect(JSON.parse(audit?.metadata_json as string)).toMatchObject({
      actingAsGrantId: operatorGrantId,
      userId: colleague.userId,
    });
  });
});

describe("two invites of one new address at once (CP5-WJ4, Codex e3a49bb5)", () => {
  /**
   * A D1 handle that runs `interleave` right before the first batch that
   * follows a statement prepared from SQL containing `marker` — here, the
   * grant's INSERT INTO tenant_memberships. So the interleaved request runs
   * between this request's creation of the identity and its grant.
   */
  function interleavingDb(marker: string, interleave: () => Promise<void>): D1Database {
    let armed = false;
    let fired = false;
    return new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (!fired && sql.includes(marker)) {
              armed = true;
            }
            return target.prepare(sql);
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (armed && !fired) {
              fired = true;
              await interleave();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  const GRANT = "INSERT INTO tenant_memberships";

  async function userIdOf(email: string): Promise<string> {
    const row = await env.DB.prepare(`SELECT "id" FROM "user" WHERE "email" = ?`).bind(email).first<{ id: string }>();
    if (row === null) {
      throw new Error(`no user ${email}`);
    }
    return row.id;
  }

  async function issuedInvites(userId: string): Promise<number> {
    return countRows(
      `SELECT COUNT(*) AS n FROM identity_invites WHERE user_id = ? AND status = 'issued'`,
      userId,
    );
  }

  /** The member has a live invitation: its link sets a password and signs them in. */
  async function expectWorkingInvitation(captured: CapturedQueue, email: string): Promise<void> {
    const jobs = captured.sent.map((body) => parseAuthEmailJob(body, env.AUTH_BASE_URL));
    expect(jobs.every((job) => job.recipient === email)).toBe(true);
    const userId = await userIdOf(email);
    expect(await issuedInvites(userId)).toBe(1);
    expect((await setPassword(tokenOf(jobs.at(-1) as AuthEmailJob))).status).toBe(200);
    expect((await signInResponse(email, NEW_PASSWORD)).status).toBe(200);
  }

  it("the second request runs between the first's creation and its grant and WINS the grant: its 201 sends the invitation", async () => {
    const captured = captureQueue();
    const email = "race-same-new@example.com";
    let second: Response | null = null;
    let seenBySecond: { no_password: number } | null = null;
    const firstDb = interleavingDb(GRANT, async () => {
      // What the second request sees: the identity, complete and password-less.
      seenBySecond = await env.DB.prepare(
        `SELECT (c."password" IS NULL) AS no_password FROM "account" AS c
         JOIN "user" AS u ON u."id" = c."userId" WHERE u."email" = ?`,
      )
        .bind(email)
        .first<{ no_password: number }>();
      second = await add({ email, name: "Test Second" }, { env: envWith({ EMAIL_QUEUE: captured.queue }) });
    });

    const first = await add(
      { email, name: "Test First" },
      { env: envWith({ DB: firstDb, EMAIL_QUEUE: captured.queue }) },
    );

    expect((second as Response | null)?.status).toBe(201);
    await expectRefusal(first, "already_member");
    // Exactly one invitation, sent by the request that answered 201 (before
    // CP5-WJ4: none — the second read the throwaway as a set password).
    expect(captured.sent).toHaveLength(1);
    expect(seenBySecond).toEqual({ no_password: 1 });
    const userId = await userIdOf(email);
    expect(await membershipStatus(userId, SHOP)).toBe("active");
    expect((await members()).find((member) => member.userId === userId)).toMatchObject({
      invited: true,
      name: "Test First",
    });
    await expectWorkingInvitation(captured, email);
  });

  it("the second request reads the new identity, then the FIRST wins the grant: the first's 201 sends the invitation", async () => {
    const captured = captureQueue();
    const email = "race-same-first-wins@example.com";
    let secondAtGrant!: () => void;
    const secondReachedGrant = new Promise<void>((resolve) => {
      secondAtGrant = resolve;
    });
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondDb = interleavingDb(GRANT, async () => {
      secondAtGrant();
      await secondReleased;
    });
    let second: Promise<Response> | null = null;
    const firstDb = interleavingDb(GRANT, async () => {
      second = add(
        { email, name: "Test Second" },
        { env: envWith({ DB: secondDb, EMAIL_QUEUE: captured.queue }) },
      );
      await secondReachedGrant;
    });

    const first = await add(
      { email, name: "Test First" },
      { env: envWith({ DB: firstDb, EMAIL_QUEUE: captured.queue }) },
    );
    expect(first.status).toBe(201);
    releaseSecond();
    await expectRefusal(await (second as unknown as Promise<Response>), "already_member");

    expect(captured.sent).toHaveLength(1);
    await expectWorkingInvitation(captured, email);
  });

  it("one new address invited by two shops at once: both answer 201 and the person holds one live invitation", async () => {
    const captured = captureQueue();
    const email = "race-two-shops@example.com";
    let second: Response | null = null;
    const firstDb = interleavingDb(GRANT, async () => {
      second = await add(
        { email, name: "Test Other Shop" },
        { env: envWith({ EMAIL_QUEUE: captured.queue }), shop: OTHER },
      );
    });

    const first = await add(
      { email, name: "Test This Shop" },
      { env: envWith({ DB: firstDb, EMAIL_QUEUE: captured.queue }) },
    );

    expect(first.status).toBe(201);
    expect((second as Response | null)?.status).toBe(201);
    const userId = await userIdOf(email);
    expect(await membershipStatus(userId, SHOP)).toBe("active");
    expect(await membershipStatus(userId, OTHER)).toBe("active");
    // Each grant sent the link; the later one superseded the earlier.
    expect(captured.sent).toHaveLength(2);
    await expectWorkingInvitation(captured, email);
  });

  it("sends the link to an existing admin left with a password nobody chose (written before their invite)", async () => {
    // The earlier console flow: created with a random password, then invited;
    // the invite expired unused. Now a shop adds them.
    const email = "throwaway-era-member@example.com";
    const person = await signUp(email, "Test Throwaway Era");
    await seedAccess(person.userId, "tenant_admin");
    await seedMembership(person.userId, OTHER);
    const invitedAt = Date.now() - 73 * 60 * 60 * 1_000;
    const issued = await issueInvite(
      envWith({ EMAIL_QUEUE: captureQueue().queue }),
      { accountType: "platform_admin", userId: operator.userId },
      person.userId,
      invitedAt,
    );
    expect(issued.status).toBe("ok");
    await env.DB.prepare(`UPDATE "account" SET "updatedAt" = ? WHERE "userId" = ?`)
      .bind(new Date(invitedAt - 60_000).toISOString(), person.userId)
      .run();

    const captured = captureQueue();
    const response = await add(
      { email, name: "Test Throwaway Era" },
      { env: envWith({ EMAIL_QUEUE: captured.queue }) },
    );
    expect(response.status).toBe(201);
    expect(captured.sent).toHaveLength(1);
    expect((await members()).find((member) => member.userId === person.userId)).toMatchObject({
      invited: true,
    });
    await expectWorkingInvitation(captured, email);
    expect((await members()).find((member) => member.userId === person.userId)).toMatchObject({
      invited: false,
    });
  });
});
