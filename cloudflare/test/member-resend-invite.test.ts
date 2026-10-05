import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { passwordResetCallbackUrl, resetPageOrigin } from "../src/auth/password-reset";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { parseAuthEmailJob } from "../src/email/auth-email-job";
import { parseCanonicalOrigins } from "../src/lib/origins";
import { ACTING_AS_TTL_MS } from "../src/platform/acting-as";
import {
  MEMBER_INVITE_EMAIL_LIMIT,
  MEMBER_INVITE_TENANT_LIMIT,
} from "../src/routes/admin-members";

/**
 * CP5-WK — a member's new invite link: POST /v1/admin/members/:userId/resend-invite
 * (src/routes/admin-members.ts, src/platform/tenant-members.ts). The same
 * harness as the members suite (admin-members.test.ts): the invite job is
 * captured through an injected EMAIL_QUEUE and its link followed through the
 * real mounted reset endpoints. Covered: who may reach it, the opaque 404
 * (byte-identical to the revoke's, whoever the user is elsewhere), the two
 * refusals, the link (the old one dies, the new one works), the audit row,
 * acting-as, the limiter shared with the add, and the two races the batch's
 * condition closes (revoked, or a password set, between the read and the batch).
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const ADMIN_HOST = "https://admin.resend.example.com";
const TEST_ORIGINS = parseCanonicalOrigins(env.CANONICAL_ORIGINS);
const ADMIN_RESET_PAGE = passwordResetCallbackUrl(TEST_ORIGINS, "admin");
const RESET_ORIGIN = resetPageOrigin(TEST_ORIGINS, "admin");
const SHOP = "resend-shop";
const OTHER = "resend-other";
const NOW = 1_789_000_000_000;
const PASSWORD = "test-password-long-enough";
const NEW_PASSWORD = "chosen-by-the-invitee-long-enough";

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
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return worker.fetch(new Request(`${ADMIN_HOST}${path}`, { body, headers, method }), options.env ?? env);
}

function add(body: unknown, options: CallOptions = {}) {
  return call("/v1/admin/members", { body, method: "POST", ...options });
}

function revoke(userId: string, options: CallOptions = {}) {
  return call(`/v1/admin/members/${userId}/revoke`, { method: "POST", ...options });
}

function resend(userId: string, options: CallOptions = {}) {
  return call(`/v1/admin/members/${userId}/resend-invite`, { method: "POST", ...options });
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

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

function tokenOf(job: AuthEmailJob): string {
  return new URL(job.actionUrl).pathname.split("/").at(-1) as string;
}

function jobOf(captured: CapturedQueue, index = 0): AuthEmailJob {
  return parseAuthEmailJob(captured.sent[index], env.AUTH_BASE_URL);
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

/** A password-less admin of `shop`, added through the shop's own invite: their first link. */
async function invitee(email: string, shop = SHOP, cookie = owner.cookie): Promise<{ token: string; userId: string }> {
  const captured = captureQueue();
  const response = await add(
    { email, name: "Test Invitee" },
    { cookie, env: envWith({ EMAIL_QUEUE: captured.queue }), shop },
  );
  expect(response.status).toBe(201);
  const { member } = await response.json<{ member: { userId: string } }>();
  expect(captured.sent).toHaveLength(1);
  // The add spent the invite buckets; each test starts from full ones.
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
  return { token: tokenOf(jobOf(captured)), userId: member.userId };
}

async function invites(userId: string): Promise<Array<{ status: string }>> {
  const rows = await env.DB.prepare(
    `SELECT status FROM identity_invites WHERE user_id = ? ORDER BY created_at, rowid`,
  )
    .bind(userId)
    .all<{ status: string }>();
  return rows.results;
}

const tokenRows = (userId: string) =>
  countRows(`SELECT COUNT(*) AS n FROM "verification" WHERE "value" = ?`, userId);

const resendAudits = (userId: string) =>
  countRows(
    `SELECT COUNT(*) AS n FROM audit_events
     WHERE action = 'platform.user_invite' AND resource_id = ? AND tenant_id IS NOT NULL`,
    userId,
  );

beforeAll(async () => {
  for (const tenant of [SHOP, OTHER]) {
    await seedTenant(tenant);
  }
  owner = await signUp("resend-owner@example.com", "Test Owner");
  colleague = await signUp("resend-colleague@example.com", "Test Colleague");
  foreignAdmin = await signUp("resend-foreign@example.com", "Test Foreign Admin");
  operator = await signUp("resend-operator@example.com", "Test Operator");
  printOp = await signUp("resend-print@example.com", "Test Printer");

  for (const person of [owner, colleague, foreignAdmin]) {
    await seedAccess(person.userId, "tenant_admin");
  }
  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(printOp.userId, "print_operator");

  await seedMembership(owner.userId, SHOP, NOW);
  await seedMembership(colleague.userId, SHOP, NOW + 1);
  await seedMembership(foreignAdmin.userId, OTHER);

  operatorGrantId = await grantActingAs(operator.userId, SHOP);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("who may reach it", () => {
  it("answers the opaque 404 to every caller the revoke refuses, sending nothing", async () => {
    const person = await invitee("reach-guard@example.com");
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    // No session; another shop's admin; no / a malformed shop; a platform user
    // without a grant on it; a print operator.
    await expectOpaque404(await resend(person.userId, { ...options, cookie: null }));
    await expectOpaque404(await resend(person.userId, { ...options, cookie: foreignAdmin.cookie }));
    await expectOpaque404(await resend(person.userId, { ...options, shop: null }));
    await expectOpaque404(await resend(person.userId, { ...options, shop: "Resend-Shop" }));
    await expectOpaque404(await resend(person.userId, { ...options, cookie: operator.cookie, shop: OTHER }));
    await expectOpaque404(await resend(person.userId, { ...options, cookie: printOp.cookie }));
    expect(captured.sent).toHaveLength(0);
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
  });

  it("refuses a cross-origin, origin-less or `null`-origin request, sending nothing", async () => {
    const person = await invitee("reach-origin@example.com");
    const captured = captureQueue();
    for (const origin of ["https://evil.example.com", null, "null"]) {
      await expectOpaque404(
        await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }), origin }),
      );
    }
    expect(captured.sent).toHaveLength(0);
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
  });

  it("answers only POST", async () => {
    const person = await invitee("reach-method@example.com");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(await resend(person.userId, { method }));
    }
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
  });

  it("is dark (opaque 404) while the invite mail is not configured, as the invite", async () => {
    const person = await invitee("reach-dark@example.com");
    await expectOpaque404(await resend(person.userId, { env: envWith({ EMAIL_QUEUE: undefined }) }));
    await expectOpaque404(await resend(person.userId, { env: envWith({ CANONICAL_ORIGINS: undefined }) }));
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the opaque 404: someone this shop's list does not show", () => {
  it("is the revoke's own answer, byte for byte, for an unknown id, a malformed one and another shop's invited admin", async () => {
    // Invited by the OTHER shop: exists, password-less, an active admin there.
    const elsewhere = await invitee("elsewhere-invited@example.com", OTHER, foreignAdmin.cookie);
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };

    const answers: string[] = [];
    for (const userId of [elsewhere.userId, foreignAdmin.userId, "unknown-user-id"]) {
      const ours = await resend(userId, options);
      expect(ours.status).toBe(404);
      answers.push(await ours.text());
      const revoked = await revoke(userId);
      expect(revoked.status).toBe(404);
      answers.push(await revoked.text());
    }
    for (const raw of ["a.b", "%2E%2E", "a%2Fb", "%ZZ", "x".repeat(129), "%2574"]) {
      await expectOpaque404(await resend(raw, options));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0] as string)).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(captured.sent).toHaveLength(0);
    // The other shop's invitation is untouched.
    expect(await invites(elsewhere.userId)).toEqual([{ status: "issued" }]);
    expect(await resendAudits(elsewhere.userId)).toBe(0);
  });

  it("is the 404 for a revoked member, as the revoke treats one", async () => {
    const person = await invitee("revoked-invitee@example.com");
    expect((await revoke(person.userId)).status).toBe(200);
    const captured = captureQueue();
    await expectOpaque404(await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) }));
    expect(captured.sent).toHaveLength(0);
    // Their live link is not superseded by a refused resend.
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the refusals", () => {
  it("409 not_invited for a member who has set a password of their own", async () => {
    const captured = captureQueue();
    await expectRefusal(
      await resend(colleague.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) }),
      "not_invited",
    );
    // Yourself too: you signed in with your password.
    await expectRefusal(
      await resend(owner.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) }),
      "not_invited",
    );
    expect(captured.sent).toHaveLength(0);
    expect(await invites(colleague.userId)).toEqual([]);
  });

  it("409 not_invited once the link was used", async () => {
    const person = await invitee("used-link@example.com");
    expect((await setPassword(person.token)).status).toBe(200);
    const captured = captureQueue();
    await expectRefusal(
      await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) }),
      "not_invited",
    );
    expect(captured.sent).toHaveLength(0);
  });

  it("409 not_invitable for an invited member whose identity the platform suspended (issueInvite's own refusal)", async () => {
    const person = await invitee("suspended-invitee@example.com");
    await env.DB.prepare(`UPDATE identity_access SET status = 'suspended' WHERE user_id = ?`)
      .bind(person.userId)
      .run();
    const captured = captureQueue();
    await expectRefusal(
      await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) }),
      "not_invitable",
    );
    expect(captured.sent).toHaveLength(0);
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
    expect(await tokenRows(person.userId)).toBe(1);
  });

  it("503 email_unavailable when the queue refuses the job: the new invite is killed, nothing live is left behind", async () => {
    const person = await invitee("queue-down-resend@example.com");
    const response = await resend(person.userId, {
      env: envWith({ EMAIL_QUEUE: captureQueue({ fail: true }).queue }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "email_unavailable", message: "The invite email could not be queued" },
    });
    // The first link was superseded by a resend whose own link is revoked:
    // a retry starts clean (issueInvite's existing behaviour).
    expect(await invites(person.userId)).toEqual([{ status: "superseded" }, { status: "revoked" }]);
    expect(await tokenRows(person.userId)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the new link", () => {
  it("CP9-OB: with no mail account a new link is still queued, and the answer says no mail can leave", async () => {
    const person = await invitee("resend-no-mail@example.com");
    const captured = captureQueue();
    const response = await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue, EMAIL_FROM: undefined }) });
    expect(response.status).toBe(202);
    const body = await response.json<{ invite: Record<string, unknown>; mailConfigured: boolean }>();
    expect(body.mailConfigured).toBe(false);
    expect(captured.sent).toHaveLength(1);
  });

  it("answers 202 with the platform invite's shape, kills the old link, and the new one sets the password", async () => {
    const person = await invitee("resend-me@example.com");
    const captured = captureQueue();
    const before = Date.now();
    const response = await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) });
    expect(response.status).toBe(202);
    const text = await response.text();
    const body = JSON.parse(text) as { invite: { expiresAt: string; surface: string; userId: string }; mailConfigured: boolean };
    // CP9-OB: whether the mail can leave, beside the invite.
    expect(Object.keys(body)).toEqual(["invite", "mailConfigured"]);
    expect(body.mailConfigured).toBe(true);
    expect(Object.keys(body.invite).sort()).toEqual(["expiresAt", "surface", "userId"]);
    expect(body.invite).toMatchObject({ surface: "admin", userId: person.userId });
    const expires = Date.parse(body.invite.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 72 * 60 * 60 * 1_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 72 * 60 * 60 * 1_000);

    // One invite mail to the person, on the admin surface's reset page.
    expect(captured.sent).toHaveLength(1);
    const job = jobOf(captured);
    expect(job.recipient).toBe("resend-me@example.com");
    expect("variant" in job ? job.variant : null).toBe("invite");
    expect(new URL(job.actionUrl).searchParams.get("callbackURL")).toBe(ADMIN_RESET_PAGE);
    expect(job.actionUrl).not.toContain("resend.example.com");
    // The answer carries no token, link or address.
    expect(text).not.toContain(tokenOf(job));
    expect(text).not.toContain("resend-me@example.com");
    expect(text).not.toContain("http");

    // The old link is dead, the new one is the person's only live link.
    expect(await invites(person.userId)).toEqual([{ status: "superseded" }, { status: "issued" }]);
    expect(await tokenRows(person.userId)).toBe(1);
    expect((await setPassword(person.token)).status).not.toBe(200);
    expect((await setPassword(tokenOf(job))).status).toBe(200);
    expect((await signInResponse("resend-me@example.com", NEW_PASSWORD)).status).toBe(200);

    // Listed as no longer invited; a further resend is refused.
    const listed = await call("/v1/admin/members");
    const members = (await listed.json<{ members: Array<{ invited: boolean; userId: string }> }>()).members;
    expect(members.find((member) => member.userId === person.userId)?.invited).toBe(false);
    await expectRefusal(await resend(person.userId), "not_invited");
  });

  it("audits the invite with THIS shop and the actor; never the address, the token or the link", async () => {
    const person = await invitee("audited-resend@example.com");
    const captured = captureQueue();
    expect((await resend(person.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) })).status).toBe(202);
    const rows = await env.DB.prepare(
      `SELECT tenant_id, actor_user_id, resource_type, metadata_json FROM audit_events
       WHERE action = 'platform.user_invite' AND resource_id = ? AND tenant_id IS NOT NULL`,
    )
      .bind(person.userId)
      .all<{ actor_user_id: string; metadata_json: string; resource_type: string; tenant_id: string }>();
    expect(rows.results).toHaveLength(1);
    const [row] = rows.results as [(typeof rows.results)[number]];
    expect(row).toMatchObject({ actor_user_id: owner.userId, resource_type: "identity_access", tenant_id: SHOP });
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["deliveryId", "expiresAt", "inviteId", "resend", "surface"]);
    expect(metadata).toMatchObject({ resend: true, surface: "admin" });
    expect(row.metadata_json).not.toContain("audited-resend@example.com");
    expect(row.metadata_json).not.toContain(tokenOf(jobOf(captured)));
    expect(row.metadata_json).not.toContain("http");
  });

  it("lets an acting-as operator resend, audited with the grant id", async () => {
    const person = await invitee("by-operator-resend@example.com");
    const captured = captureQueue();
    const response = await resend(person.userId, {
      cookie: operator.cookie,
      env: envWith({ EMAIL_QUEUE: captured.queue }),
    });
    expect(response.status).toBe(202);
    expect(captured.sent).toHaveLength(1);
    const row = await env.DB.prepare(
      `SELECT tenant_id, actor_user_id, metadata_json FROM audit_events
       WHERE action = 'platform.user_invite' AND resource_id = ? AND tenant_id IS NOT NULL`,
    )
      .bind(person.userId)
      .first<{ actor_user_id: string; metadata_json: string; tenant_id: string }>();
    expect(row).toMatchObject({ actor_user_id: operator.userId, tenant_id: SHOP });
    expect(JSON.parse(row?.metadata_json as string)).toMatchObject({
      actingAsGrantId: operatorGrantId,
      resend: true,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the limiter: the add's two buckets", () => {
  it("caps the invite mails one address gets, adds and resends together, across shops", async () => {
    const person = await invitee("limit-resend@example.com");
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    for (let attempt = 0; attempt < MEMBER_INVITE_EMAIL_LIMIT; attempt += 1) {
      expect((await resend(person.userId, options)).status).toBe(202);
    }
    const limited = await resend(person.userId, options);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(captured.sent).toHaveLength(MEMBER_INVITE_EMAIL_LIMIT);
    // The same inbox through another shop's add: the same bucket.
    expect(
      (
        await add(
          { email: "limit-resend@example.com", name: "Test Limit" },
          { ...options, cookie: foreignAdmin.cookie, shop: OTHER },
        )
      ).status,
    ).toBe(429);
    // The live link is the last one sent.
    expect((await setPassword(tokenOf(jobOf(captured, MEMBER_INVITE_EMAIL_LIMIT - 1)))).status).toBe(200);
  });

  it("spends the shop's bucket on every admitted request; the address's only when a link is owed", async () => {
    const elsewhere = await invitee("limit-elsewhere@example.com", OTHER, foreignAdmin.cookie);
    const person = await invitee("limit-shop@example.com");
    const captured = captureQueue();
    const options = { env: envWith({ EMAIL_QUEUE: captured.queue }) };
    // A password holder's refusals do not touch their inbox's bucket.
    for (let attempt = 0; attempt < MEMBER_INVITE_EMAIL_LIMIT + 2; attempt += 1) {
      await expectRefusal(await resend(colleague.userId, options), "not_invited");
    }
    await expectRefusal(await add({ email: colleague.email, name: "Test Colleague" }, options), "already_member");

    // The shop's bucket: the refusals and 404s above and below all count.
    const spent = MEMBER_INVITE_EMAIL_LIMIT + 2 + 1;
    for (let attempt = spent; attempt < MEMBER_INVITE_TENANT_LIMIT; attempt += 1) {
      expect((await resend("unknown-user-id", options)).status).toBe(404);
    }
    expect((await resend(person.userId, options)).status).toBe(429);
    expect(captured.sent).toHaveLength(0);
    // Another shop keeps its own allowance.
    expect(
      (await resend(elsewhere.userId, { ...options, cookie: foreignAdmin.cookie, shop: OTHER })).status,
    ).toBe(202);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the races the batch's condition closes", () => {
  /**
   * A D1 handle that runs `interleave` right before the first batch that
   * follows a statement prepared from SQL containing `marker` — here the
   * INSERT INTO identity_invites of issueInvite's recording batch. So the
   * interleaved change lands after the route read the person as listed and
   * invited, and before the batch that would supersede their link.
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

  const RECORD = "INSERT INTO identity_invites";

  it("revoked in between: no new link, the old one stays live, the answer is the 404", async () => {
    const person = await invitee("race-revoked@example.com");
    const captured = captureQueue();
    let fired = false;
    const db = interleavingDb(RECORD, async () => {
      fired = true;
      await env.DB.prepare(
        `UPDATE tenant_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?`,
      )
        .bind(SHOP, person.userId)
        .run();
    });

    await expectOpaque404(await resend(person.userId, { env: envWith({ DB: db, EMAIL_QUEUE: captured.queue }) }));

    expect(fired).toBe(true);
    expect(captured.sent).toHaveLength(0);
    expect(await invites(person.userId)).toEqual([{ status: "issued" }]);
    // The token minted for the refused link is gone; the old link's remains.
    expect(await tokenRows(person.userId)).toBe(1);
    expect(await resendAudits(person.userId)).toBe(0);
    expect((await setPassword(person.token)).status).toBe(200);
  });

  it("a password set in between (the old link used): no new link, the answer is 409 not_invited", async () => {
    const person = await invitee("race-password@example.com");
    const captured = captureQueue();
    let fired = false;
    const db = interleavingDb(RECORD, async () => {
      fired = true;
      expect((await setPassword(person.token)).status).toBe(200);
    });

    await expectRefusal(
      await resend(person.userId, { env: envWith({ DB: db, EMAIL_QUEUE: captured.queue }) }),
      "not_invited",
    );

    expect(fired).toBe(true);
    expect(captured.sent).toHaveLength(0);
    // Only the first invitation exists (used, so its token row is consumed).
    expect(await invites(person.userId)).toHaveLength(1);
    expect(await tokenRows(person.userId)).toBe(0);
    expect(await resendAudits(person.userId)).toBe(0);
    expect((await signInResponse("race-password@example.com", NEW_PASSWORD)).status).toBe(200);
  });
});
