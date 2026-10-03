import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { authorizePlatformAdmin } from "../src/auth/live-authorization";
import {
  canonicalResetLinkRequest,
  passwordResetCallbackUrl,
  resetPageOrigin,
  resetPageOrigins,
} from "../src/auth/password-reset";
import { hashEmailRecipient, parseAuthEmailJob } from "../src/email/auth-email-job";
import type { AuthEmailJob } from "../src/email/auth-email-job";
import { RESEND_FETCH_OVERRIDE } from "../src/email/email-queue-consumer";
import { type CanonicalOrigins, parseCanonicalOrigins } from "../src/lib/origins";
import {
  INVITE_TOKEN_TTL_SECONDS,
  inviteSurfaceFor,
  issueInvite,
} from "../src/platform/invites";

/**
 * CP3-B — platform-issued password-set links. The emailed job is captured
 * through an injected EMAIL_QUEUE; the token is read from it exactly as the
 * recipient would read it from the email, and every consumption goes through
 * the real mounted reset endpoints.
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.invites.example.com";
const ADMIN_HOST = "https://admin.invites.example.com";
// CP5-WA: the reset pages are the admin surface's (the web origin only while
// the test config's allowlist does not list `admin`); read from the config so
// this suite holds before and after the allowlist gains it.
const TEST_ORIGINS = parseCanonicalOrigins(env.CANONICAL_ORIGINS);
const RESET_ORIGIN = resetPageOrigin(TEST_ORIGINS, "admin");
const ADMIN_RESET_PAGE = passwordResetCallbackUrl(TEST_ORIGINS, "admin");
const PLATFORM_RESET_PAGE = passwordResetCallbackUrl(TEST_ORIGINS, "platform");
const SHOP = "invites-shop";
const NOW = 1_789_000_000_000;
const PASSWORD = "test-password-long-enough";
const NEW_PASSWORD = "chosen-by-the-invitee-long-enough";
const HOUR_MS = 60 * 60 * 1_000;
const INVITE_TTL_MS = 72 * HOUR_MS;

interface Person {
  cookie: string;
  email: string;
  userId: string;
}

let operator: Person;
let platformTarget: Person;
let shopAdmin: Person;
let printOperator: Person;
let bare: Person;
let suspendedAdmin: Person;
let productCounter = 0;

const IMPORTED_ID = "imported-0b7c9f2e-4a51-4d0e-9a8e-6f1f0f0c2a11";
const IMPORTED_EMAIL = "imported-admin@example.com";

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

async function seedAccess(userId: string, accountType: string, status = "active") {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(userId, accountType, status, NOW, NOW)
    .run();
}

async function seedMembership(userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), SHOP, userId, NOW, NOW)
    .run();
}

function invite(
  userId: string,
  options: { cookie?: string; env?: Env; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ cookie: options.cookie ?? operator.cookie });
  const origin = options.origin === undefined ? PLATFORM_HOST : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return worker.fetch(
    new Request(`${PLATFORM_HOST}/v1/platform/users/${userId}/invite`, {
      headers,
      method: "POST",
    }),
    options.env ?? env,
  );
}

/** Invites through the route and returns the captured job. */
async function inviteAndCapture(userId: string): Promise<{ job: AuthEmailJob; response: Response }> {
  const captured = captureQueue();
  const response = await invite(userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) });
  expect(response.status).toBe(202);
  expect(captured.sent).toHaveLength(1);
  return { job: parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL), response };
}

function tokenOf(job: AuthEmailJob): string {
  return new URL(job.actionUrl).pathname.split("/").at(-1) as string;
}

/** Follows the emailed link: the token if it is valid, "INVALID_TOKEN" if not. */
async function followLink(actionUrl: string): Promise<string> {
  const response = await worker.fetch(new Request(actionUrl, { redirect: "manual" }), env);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return location.searchParams.get("token") ?? location.searchParams.get("error") ?? "";
}

async function setPassword(token: string, newPassword = NEW_PASSWORD): Promise<Response> {
  return worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
      body: JSON.stringify({ newPassword, token }),
      headers: { "content-type": "application/json", origin: RESET_ORIGIN },
      method: "POST",
    }),
    env,
  );
}

function createProduct(cookie: string): Promise<Response> {
  productCounter += 1;
  return worker.fetch(
    new Request(`${ADMIN_HOST}/v1/admin/products`, {
      body: JSON.stringify({
        currency: "SEK",
        name: `Invited Product ${productCounter}`,
        priceMinor: 10_000,
        sku: `INVITED-${productCounter}`,
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        origin: ADMIN_HOST,
        "x-shop-id": SHOP,
      },
      method: "POST",
    }),
    env,
  );
}

async function inviteRows(userId: string) {
  const rows = await env.DB.prepare(
    `SELECT invite_id, status, surface, delivery_id, issued_by, expires_at, created_at
     FROM identity_invites WHERE user_id = ? ORDER BY created_at, invite_id`,
  )
    .bind(userId)
    .all<{
      created_at: string;
      delivery_id: string;
      expires_at: string;
      invite_id: string;
      issued_by: string;
      status: string;
      surface: string;
    }>();
  return rows.results;
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, 'active', 'Test Invite Shop', 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(SHOP, NOW, NOW)
    .run();

  operator = await signUp("invite-operator@example.com", "Test Operator");
  platformTarget = await signUp("invite-platform@example.com", "Test Platform Admin");
  shopAdmin = await signUp("invite-shop-admin@example.com", "Test Admin");
  printOperator = await signUp("invite-print@example.com", "Test Printer");
  bare = await signUp("invite-bare@example.com", "Test Bare");
  suspendedAdmin = await signUp("invite-suspended@example.com", "Test Suspended");

  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(platformTarget.userId, "platform_admin");
  await seedAccess(shopAdmin.userId, "tenant_admin");
  await seedAccess(printOperator.userId, "print_operator");
  await seedAccess(suspendedAdmin.userId, "tenant_admin", "suspended");
  await seedMembership(shopAdmin.userId);

  // An identity shaped the way the importer creates one (MIGRATION_MANIFEST
  // §a): a user row and a credential account with NO password.
  const iso = new Date(NOW).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, 'Test Imported Admin', ?, 1, ?, ?)`,
    ).bind(IMPORTED_ID, IMPORTED_EMAIL, iso, iso),
    env.DB.prepare(
      `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
       VALUES (?, ?, 'credential', ?, NULL, ?, ?)`,
    ).bind(`account-${IMPORTED_ID}`, IMPORTED_ID, IMPORTED_ID, iso, iso),
  ]);
  await seedAccess(IMPORTED_ID, "tenant_admin");
  await seedMembership(IMPORTED_ID);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issuing an invite", () => {
  it("queues a reset email built only from the allowlist, and answers without the token", async () => {
    const { job, response } = await inviteAndCapture(shopAdmin.userId);
    const text = await response.text();
    const body = JSON.parse(text) as { invite: Record<string, unknown> };

    expect(Object.keys(body)).toEqual(["invite"]);
    expect(Object.keys(body.invite).sort()).toEqual(["expiresAt", "surface", "userId"]);
    expect(body.invite).toMatchObject({ surface: "admin", userId: shopAdmin.userId });

    // Nothing the operator receives can be used as the capability.
    const token = tokenOf(job);
    expect(text).not.toContain(token);
    expect(text).not.toContain("reset-password");
    expect(text).not.toContain("callbackURL");
    expect(text).not.toContain(shopAdmin.email);

    // The existing reset machinery: kind, ledger, link shape.
    expect(job.kind).toBe("password_reset");
    expect(job.recipient).toBe(shopAdmin.email);
    expect(job.tenantId).toBeUndefined();
    const link = new URL(job.actionUrl);
    expect(link.origin).toBe(AUTH_ORIGIN);
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/[A-Za-z0-9]{32}$/);
    expect([...link.searchParams.keys()]).toEqual(["callbackURL"]);
    // From the allowlist — never the host the operator called from.
    expect(link.searchParams.get("callbackURL")).toBe(ADMIN_RESET_PAGE);
    expect(job.actionUrl).not.toContain("invites.example.com");

    await expect(
      env.DB.prepare(
        `SELECT kind, status, recipient_hash, tenant_id
         FROM email_deliveries WHERE delivery_id = ?`,
      )
        .bind(job.deliveryId)
        .first(),
    ).resolves.toEqual({
      kind: "password_reset",
      recipient_hash: await hashEmailRecipient(shopAdmin.email),
      status: "pending",
      tenant_id: null,
    });

    const rows = await inviteRows(shopAdmin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delivery_id: job.deliveryId,
      issued_by: operator.userId,
      status: "issued",
      surface: "admin",
    });

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, resource_type, metadata_json
       FROM audit_events WHERE action = 'platform.user_invite' AND resource_id = ?`,
    )
      .bind(shopAdmin.userId)
      .first<{ actor_user_id: string; metadata_json: string; resource_type: string }>();
    expect(audit).toMatchObject({ actor_user_id: operator.userId, resource_type: "identity_access" });
    expect(JSON.parse(audit?.metadata_json as string)).toMatchObject({
      deliveryId: job.deliveryId,
      inviteId: rows[0]?.invite_id,
      surface: "admin",
    });
    expect(audit?.metadata_json).not.toContain(token);
    expect(audit?.metadata_json).not.toContain(shopAdmin.email);
  });

  it("chooses the surface by account type: platform admin → platform, tenant admin → admin", async () => {
    const { job, response } = await inviteAndCapture(platformTarget.userId);
    await expect(response.json()).resolves.toMatchObject({
      invite: { surface: "platform", userId: platformTarget.userId },
    });
    // The platform page: the admin origin unless the allowlist names another (D102).
    expect(new URL(job.actionUrl).searchParams.get("callbackURL")).toBe(PLATFORM_RESET_PAGE);

    expect(inviteSurfaceFor("platform_admin")).toBe("platform");
    expect(inviteSurfaceFor("tenant_admin")).toBe("admin");
    expect(inviteSurfaceFor("print_operator")).toBeNull();
    expect(inviteSurfaceFor("ordinary")).toBeNull();
    expect(inviteSurfaceFor(null)).toBeNull();
  });

  it("takes each surface's origin from the allowlist once it lists one", () => {
    const widened = {
      admin: "https://admin.allowlist.invalid",
      api: "https://api.allowlist.invalid",
      platform: "https://platform.allowlist.invalid",
      web: "https://web.allowlist.invalid",
    } as unknown as CanonicalOrigins;
    const narrow = { api: "https://api.allowlist.invalid", web: "https://web.allowlist.invalid" };

    expect(resetPageOrigin(widened, "platform")).toBe("https://platform.allowlist.invalid");
    expect(resetPageOrigin(widened, "admin")).toBe("https://admin.allowlist.invalid");
    // CP5-WA: once `admin` is listed, no reset page is on the web origin.
    expect(resetPageOrigins(widened).sort()).toEqual([
      "https://admin.allowlist.invalid",
      "https://platform.allowlist.invalid",
    ]);
    // Transitional: an allowlist without `admin` lands both on the web origin.
    expect(resetPageOrigin(narrow, "platform")).toBe("https://web.allowlist.invalid");
    expect(resetPageOrigin(narrow, "admin")).toBe("https://web.allowlist.invalid");
    expect(resetPageOrigins(narrow)).toEqual(["https://web.allowlist.invalid"]);

    // The link handler keeps an allowlisted reset page and replaces anything
    // else — the API origin, a lookalike path, and the storefront's page a
    // pre-CP5 link carries — with the admin page.
    const linkTo = (callback: string) =>
      new URL(
        canonicalResetLinkRequest(
          new Request(
            `${AUTH_ORIGIN}/api/auth/reset-password/abcdefghijklmnopqrstuvwx?callbackURL=${encodeURIComponent(callback)}&extra=1`,
          ),
          widened,
        ).url,
      );
    const kept = linkTo(passwordResetCallbackUrl(widened, "admin"));
    expect([...kept.searchParams.keys()]).toEqual(["callbackURL"]);
    expect(kept.searchParams.get("callbackURL")).toBe("https://admin.allowlist.invalid/reset-password");
    for (const doctored of [
      "https://evil.example.com/reset-password",
      "https://api.allowlist.invalid/reset-password",
      "https://admin.allowlist.invalid/reset-password/../steal",
      "https://admin.allowlist.invalid/elsewhere",
      "https://web.allowlist.invalid/reset-password",
    ]) {
      expect(linkTo(doctored).searchParams.get("callbackURL"), doctored).toBe(
        "https://admin.allowlist.invalid/reset-password",
      );
    }
    expect(
      linkTo(passwordResetCallbackUrl(widened, "platform")).searchParams.get("callbackURL"),
    ).toBe("https://platform.allowlist.invalid/reset-password");
  });
});

describe("the invite token", () => {
  it("lives 72 hours: valid just before the boundary, dead just after (injected issue time)", async () => {
    expect(INVITE_TOKEN_TTL_SECONDS).toBe(72 * 60 * 60);
    const principal = await authorizePlatformAdmin(env.DB, operator.userId);
    if (principal === null) {
      throw new Error("operator is not a platform admin");
    }

    const before = captureQueue();
    const beforeNow = Date.now() - INVITE_TTL_MS + 30_000;
    const valid = await issueInvite(envWith({ EMAIL_QUEUE: before.queue }), principal, shopAdmin.userId, beforeNow);
    expect(valid).toEqual({
      invite: {
        expiresAt: new Date(beforeNow + INVITE_TTL_MS).toISOString(),
        surface: "admin",
        userId: shopAdmin.userId,
      },
      status: "ok",
    });
    const validJob = parseAuthEmailJob(before.sent[0], env.AUTH_BASE_URL);
    expect(await followLink(validJob.actionUrl)).toBe(tokenOf(validJob));

    const after = captureQueue();
    const afterNow = Date.now() - INVITE_TTL_MS - 1_000;
    await issueInvite(envWith({ EMAIL_QUEUE: after.queue }), principal, shopAdmin.userId, afterNow);
    const expiredJob = parseAuthEmailJob(after.sent[0], env.AUTH_BASE_URL);
    expect(await followLink(expiredJob.actionUrl)).toBe("INVALID_TOKEN");
    expect((await setPassword(tokenOf(expiredJob))).status).toBe(400);
  });

  it("lives 72 hours through the route, against the clock Better Auth itself reads", async () => {
    const issuedAt = Date.now();
    vi.useFakeTimers({ now: issuedAt, toFake: ["Date"] });
    const { job } = await inviteAndCapture(platformTarget.userId);

    vi.setSystemTime(issuedAt + INVITE_TTL_MS - 1_000);
    expect(await followLink(job.actionUrl)).toBe(tokenOf(job));

    vi.setSystemTime(issuedAt + INVITE_TTL_MS + 1_000);
    expect(await followLink(job.actionUrl)).toBe("INVALID_TOKEN");
  });

  it("is single use, and lets an imported password-less admin in", async () => {
    // No password yet: every sign-in is the generic failure.
    expect((await signInResponse(IMPORTED_EMAIL, "any-password-long-enough")).status).toBe(401);

    const { job } = await inviteAndCapture(IMPORTED_ID);
    const token = tokenOf(job);
    expect(job.recipient).toBe(IMPORTED_EMAIL);
    expect(await followLink(job.actionUrl)).toBe(token);

    const set = await setPassword(token);
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toEqual({ status: true });

    // Single use: the same token is refused afterwards, both ways.
    expect((await setPassword(token, "another-password-long-enough")).status).toBe(400);
    expect(await followLink(job.actionUrl)).toBe("INVALID_TOKEN");

    const signedIn = await signInResponse(IMPORTED_EMAIL, NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
    expect((await createProduct(cookieOf(signedIn))).status).toBe(201);
  });

  it("is invalidated by the next invite for the same user", async () => {
    const first = await inviteAndCapture(shopAdmin.userId);
    const second = await inviteAndCapture(shopAdmin.userId);

    expect(await followLink(first.job.actionUrl)).toBe("INVALID_TOKEN");
    expect(await followLink(second.job.actionUrl)).toBe(tokenOf(second.job));

    const rows = await inviteRows(shopAdmin.userId);
    expect(rows.filter((row) => row.status === "issued")).toEqual([
      expect.objectContaining({ delivery_id: second.job.deliveryId }),
    ]);
    expect(rows.find((row) => row.delivery_id === first.job.deliveryId)?.status).toBe("superseded");
  });

  it("dies when the identity is deactivated", async () => {
    const { job } = await inviteAndCapture(shopAdmin.userId);
    const deactivated = await worker.fetch(
      new Request(`${PLATFORM_HOST}/v1/platform/users/${shopAdmin.userId}/deactivate`, {
        headers: { cookie: operator.cookie, origin: PLATFORM_HOST },
        method: "POST",
      }),
      env,
    );
    expect(deactivated.status).toBe(200);

    expect(await followLink(job.actionUrl)).toBe("INVALID_TOKEN");
    const rows = await inviteRows(shopAdmin.userId);
    expect(rows.find((row) => row.delivery_id === job.deliveryId)?.status).toBe("revoked");
    expect(rows.filter((row) => row.status === "issued")).toEqual([]);

    // And a suspended identity cannot be invited.
    const captured = captureQueue();
    const refused = await invite(shopAdmin.userId, { env: envWith({ EMAIL_QUEUE: captured.queue }) });
    expect(refused.status).toBe(409);
    expect(captured.sent).toEqual([]);
  });
});

describe("refusals", () => {
  it.each([
    ["a print operator", () => printOperator.userId],
    ["a user with no identity", () => bare.userId],
    ["a suspended tenant admin", () => suspendedAdmin.userId],
  ])("answers 409 not_invitable for %s and queues nothing", async (_label, target) => {
    const captured = captureQueue();
    const response = await invite(target(), { env: envWith({ EMAIL_QUEUE: captured.queue }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_invitable", message: "The identity cannot be invited" },
    });
    expect(captured.sent).toEqual([]);
    expect(await inviteRows(target())).toEqual([]);
  });

  it("answers the opaque 404 for an unknown or malformed user id", async () => {
    for (const segment of ["no-such-user", "a%2Fb", "a.b"]) {
      const captured = captureQueue();
      const response = await invite(segment, { env: envWith({ EMAIL_QUEUE: captured.queue }) });
      expect(response.status, segment).toBe(404);
      expect(captured.sent).toEqual([]);
    }
  });

  it.each([
    ["no session", () => ({ cookie: "better-auth.session_token=nothing" })],
    ["a print-operator session", () => ({ cookie: printOperator.cookie })],
    ["a cross-site Origin", () => ({ origin: "https://evil.example.com" })],
    ["no Origin", () => ({ origin: null })],
  ] as const)("answers the opaque 404 to %s and queues nothing", async (_label, options) => {
    const captured = captureQueue();
    const response = await invite(platformTarget.userId, {
      ...options(),
      env: envWith({ EMAIL_QUEUE: captured.queue }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(captured.sent).toEqual([]);
  });

  it.each([
    ["no EMAIL_QUEUE", { EMAIL_QUEUE: undefined }],
    ["no CANONICAL_ORIGINS", { CANONICAL_ORIGINS: undefined }],
  ])("is dark with %s", async (_label, overrides) => {
    const response = await invite(platformTarget.userId, { env: envWith(overrides) });
    expect(response.status).toBe(404);
  });

  it("answers 503 when the queue refuses, and leaves no live token behind", async () => {
    const broken = captureQueue({ fail: true });
    const response = await invite(platformTarget.userId, {
      env: envWith({ EMAIL_QUEUE: broken.queue }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "email_unavailable", message: "The invite email could not be queued" },
    });

    const rows = await inviteRows(platformTarget.userId);
    const last = rows.at(-1);
    expect(last?.status).toBe("revoked");
    expect(rows.filter((row) => row.status === "issued")).toEqual([]);
    await expect(
      env.DB.prepare(
        "SELECT status, last_error_code FROM email_deliveries WHERE delivery_id = ?",
      )
        .bind(last?.delivery_id)
        .first(),
    ).resolves.toEqual({ last_error_code: "E_ENQUEUE", status: "failed" });
  });
});

describe("review round 1", () => {
  it("goes out with the invite wording, through the ordinary ledger and consumer", async () => {
    const { job } = await inviteAndCapture(platformTarget.userId);
    expect(job).toMatchObject({ kind: "password_reset", variant: "invite" });

    const requests: Request[] = [];
    const batch = createMessageBatch("chopshop-test-email", [
      { attempts: 1, body: job, id: "invite-msg-1", timestamp: new Date() },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(
      batch,
      envWith({
        [RESEND_FETCH_OVERRIDE]: async (request: Request) => {
          requests.push(request.clone() as unknown as Request);
          return Response.json({ id: "re_invite_1" });
        },
      }),
    );
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["invite-msg-1"]);
    expect(requests).toHaveLength(1);

    const payload = await (requests[0] as Request).json<{ subject: string; text: string; to: string[] }>();
    expect(payload.to).toEqual([platformTarget.email]);
    expect(payload.subject).toBe("Välj ditt lösenord för ChopShop");
    expect(payload.text).toContain("Ett konto har skapats åt dig på ChopShop.");
    expect(payload.text).toContain("Länken gäller i 72 timmar");
    expect(payload.text).toContain(job.actionUrl);

    await expect(
      env.DB.prepare("SELECT kind, status FROM email_deliveries WHERE delivery_id = ?")
        .bind(job.deliveryId)
        .first(),
    ).resolves.toEqual({ kind: "password_reset", status: "sent" });
  });

  it("removes its token row and rethrows when the batch faults", async () => {
    const principal = await authorizePlatformAdmin(env.DB, operator.userId);
    if (principal === null) {
      throw new Error("operator is not a platform admin");
    }
    const countTokens = async () =>
      (
        await env.DB.prepare('SELECT COUNT(*) AS total FROM "verification" WHERE "value" = ?')
          .bind(platformTarget.userId)
          .first<{ total: number }>()
      )?.total ?? 0;
    const tokensBefore = await countTokens();
    const invitesBefore = (await inviteRows(platformTarget.userId)).length;

    // The fault hits the invite batch (5 statements) and nothing else, and it
    // records that the token row did exist at that moment.
    const fault = new Error("injected batch fault");
    let tokensAtFault = -1;
    const faultyDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 5) {
              tokensAtFault = await countTokens();
              throw fault;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const captured = captureQueue();
    await expect(
      issueInvite(
        envWith({ DB: faultyDb, EMAIL_QUEUE: captured.queue }),
        principal,
        platformTarget.userId,
        Date.now(),
      ),
    ).rejects.toBe(fault);

    expect(tokensAtFault).toBe(tokensBefore + 1);
    expect(await countTokens()).toBe(tokensBefore);
    expect((await inviteRows(platformTarget.userId)).length).toBe(invitesBefore);
    expect(captured.sent).toEqual([]);
  });
});
