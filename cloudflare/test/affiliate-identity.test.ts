import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { authorizeAffiliate } from "../src/auth/live-authorization";
import { authorizeAffiliateRequest } from "../src/auth/request-authorization";
import { readSessionSelf } from "../src/auth/session-self";
import { passwordResetCallbackUrl, resetPageOrigin } from "../src/auth/password-reset";
import { type AuthEmailJob, parseAuthEmailJob } from "../src/email/auth-email-job";
import { parseCanonicalOrigins } from "../src/lib/origins";
import { inviteSurfaceFor, issueInvite } from "../src/platform/invites";
import { createInvitedUser, parseCreateUserInput } from "../src/platform/provision-users";
import { parseUserListQuery } from "../src/platform/user-directory";
import { revokeAffiliateMembership } from "../src/platform/user-lifecycle";
import { count, nextId, seedAffiliate, seedAffiliateMembership } from "./affiliate-fixtures";
import { seedTenant } from "./dispatch-fixtures";

/**
 * CP13 — the affiliate identity (design §1): the account type, the guard,
 * `/v1/me`, the invite, the one-kind boundary in both directions and the
 * conversion of an UNACCEPTED affiliate address (R2-6). The portal and admin
 * route matrices are in test/affiliate-routes.test.ts.
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const HOST = "https://admin.affid.test";
const PLATFORM_HOST = "https://console.affid.test";
const PASSWORD = "test-password-long-enough";
const NEW_PASSWORD = "chosen-by-the-affiliate-long-enough";
const SHOP = "affid-shop";
const SHOP_B = "affid-shop-b";
const TEST_ORIGINS = parseCanonicalOrigins(env.CANONICAL_ORIGINS);
const RESET_ORIGIN = resetPageOrigin(TEST_ORIGINS, "admin");

interface Person {
  cookie: string;
  email: string;
  userId: string;
}

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

async function signIn(email: string, password = PASSWORD): Promise<Response> {
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

async function signUp(email: string, accountType: string | null): Promise<Person> {
  await drainAuthLimiter();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const userId = (await response.json<{ user: { id: string } }>()).user.id;
  if (accountType !== null) {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
      .bind(userId, accountType, now, now)
      .run();
  }
  const signedIn = await signIn(email);
  expect(signedIn.status).toBe(200);
  return { cookie: cookieOf(signedIn), email, userId };
}

async function adminMembership(tenantId: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(nextId("m"), tenantId, userId, now, now)
    .run();
}

function request(path: string, person: Person | null, options: { method?: string; shopId?: string; body?: unknown; host?: string } = {}): Request {
  const host = options.host ?? HOST;
  const headers = new Headers({ origin: host });
  if (person !== null) {
    headers.set("cookie", person.cookie);
  }
  if (options.shopId !== undefined) {
    headers.set("x-shop-id", options.shopId);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`${host}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "GET",
  });
}

let affiliate: Person;
let affiliateId = "";
let shopAdmin: Person;
let platformAdmin: Person;

beforeAll(async () => {
  await seedTenant(SHOP, "Affid Shop");
  await seedTenant(SHOP_B, "Affid Shop B");
  affiliate = await signUp("anna@affid.test", "affiliate");
  affiliateId = (await seedAffiliate({ code: "ANNA10", tenantId: SHOP, userId: affiliate.userId })).affiliateId;
  await seedAffiliateMembership(SHOP, affiliate.userId);
  shopAdmin = await signUp("admin@affid.test", "tenant_admin");
  await adminMembership(SHOP, shopAdmin.userId);
  platformAdmin = await signUp("platform@affid.test", "platform_admin");
});

describe("the affiliate kind", () => {
  it("lands on the EXISTING admin surface (no new reset surface)", () => {
    expect(inviteSurfaceFor("affiliate")).toBe("admin");
    expect(inviteSurfaceFor("tenant_admin")).toBe("admin");
    expect(inviteSurfaceFor("print_operator")).toBeNull();
  });

  it("is filterable in the platform directory", () => {
    expect(parseUserListQuery(new URL("https://x.test/v1/platform/users?accountType=affiliate"))?.accountType).toBe("affiliate");
  });

  it("is never creatable through the platform's create-user route", () => {
    expect(parseCreateUserInput({ accountType: "affiliate", email: "x@affid.test" })).toBeNull();
    expect(parseCreateUserInput({ accountType: "affiliate", email: "x@affid.test", password: PASSWORD })).toBeNull();
  });

  it("is creatable password-less by createInvitedUser (the shop's approval path)", async () => {
    const created = await createInvitedUser(
      env,
      { accountType: "platform_admin", userId: platformAdmin.userId },
      { accountType: "affiliate", email: "fresh@affid.test", name: "Fresh" },
      Date.now(),
    );
    expect(created).toMatchObject({ status: "ok", user: { accountType: "affiliate", email: "fresh@affid.test" } });
    const row = await env.DB.prepare(
      `SELECT a.account_type, (SELECT COUNT(*) FROM "account" WHERE "userId" = a.user_id AND "password" IS NOT NULL) AS passwords
       FROM identity_access AS a WHERE a.user_id = ?`,
    )
      .bind(created.status === "ok" ? created.user.userId : "")
      .first<{ account_type: string; passwords: number }>();
    expect(row).toEqual({ account_type: "affiliate", passwords: 0 });
  });
});

describe("the guard (authorizeAffiliateRequest) and /v1/me", () => {
  it("admits the affiliate of the named shop, and nobody else", async () => {
    const principal = await authorizeAffiliateRequest(env, request("/v1/affiliate/me", affiliate, { shopId: SHOP }));
    expect(principal).toEqual({ accountType: "affiliate", affiliateId, tenantId: SHOP, userId: affiliate.userId });
    // No shop named, another shop, no session, an admin's session.
    expect(await authorizeAffiliateRequest(env, request("/v1/affiliate/me", affiliate))).toBeNull();
    expect(await authorizeAffiliateRequest(env, request("/v1/affiliate/me", affiliate, { shopId: SHOP_B }))).toBeNull();
    expect(await authorizeAffiliateRequest(env, request("/v1/affiliate/me", null, { shopId: SHOP }))).toBeNull();
    expect(await authorizeAffiliateRequest(env, request("/v1/affiliate/me", shopAdmin, { shopId: SHOP }))).toBeNull();
    expect(await authorizeAffiliateRequest(env, request("/v1/affiliate/me", platformAdmin, { shopId: SHOP }))).toBeNull();
  });

  it("refuses a revoked membership, a suspended identity and a suspended shop, live", async () => {
    const person = await signUp(`live-${nextId("x")}@affid.test`, "affiliate");
    await seedAffiliate({ code: "LIVE10", tenantId: SHOP, userId: person.userId });
    await seedAffiliateMembership(SHOP, person.userId);
    expect(await authorizeAffiliate(env.DB, person.userId, SHOP)).not.toBeNull();

    await env.DB.prepare("UPDATE identity_access SET status = 'suspended' WHERE user_id = ?").bind(person.userId).run();
    expect(await authorizeAffiliate(env.DB, person.userId, SHOP)).toBeNull();
    await env.DB.prepare("UPDATE identity_access SET status = 'active' WHERE user_id = ?").bind(person.userId).run();

    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").bind(SHOP).run();
    expect(await authorizeAffiliate(env.DB, person.userId, SHOP)).toBeNull();
    await env.DB.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").bind(SHOP).run();

    // The shop removes the affiliate ("Ta bort"): inactive + membership revoked.
    const removed = await revokeAffiliateMembership(
      env.DB,
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      (await env.DB.prepare("SELECT affiliate_id FROM affiliates WHERE user_id = ?").bind(person.userId).first<{ affiliate_id: string }>())
        ?.affiliate_id ?? "",
      Date.now(),
    );
    expect(removed).toEqual({ status: "ok" });
    expect(await authorizeAffiliate(env.DB, person.userId, SHOP)).toBeNull();
    const row = await env.DB.prepare("SELECT status FROM affiliates WHERE user_id = ?").bind(person.userId).first<{ status: string }>();
    expect(row?.status).toBe("inactive");
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.revoke' AND tenant_id = ?", SHOP)).toBe(1);
  });

  it("/v1/me serves the affiliate kind with ONLY its affiliate memberships", async () => {
    // An admin membership row for the affiliate's user (never grantable, but
    // even if one existed) is not listed: the role is the predicate's.
    await adminMembership(SHOP_B, affiliate.userId);
    const response = await worker.fetch(request("/v1/me", affiliate), env);
    expect(response.status).toBe(200);
    const body = await response.json<{
      accountType: string;
      actingAs: unknown[];
      memberships: Array<{ role: string; tenantId: string }>;
      platform: boolean;
    }>();
    expect(body.accountType).toBe("affiliate");
    expect(body.platform).toBe(false);
    expect(body.actingAs).toEqual([]);
    expect(body.memberships).toEqual([
      { published: true, role: "affiliate", shopName: "Affid Shop", status: "active", tenantId: SHOP },
    ]);
    // And the admin's /v1/me never lists an affiliate membership.
    const self = await readSessionSelf(env.DB, shopAdmin.userId, Date.now());
    expect(self?.memberships.every((membership) => membership.role === "admin")).toBe(true);
  });

  it("every admin and platform route answers the affiliate session with the opaque 404", async () => {
    for (const [path, shopId, host] of [
      ["/v1/admin/shop", SHOP, HOST],
      ["/v1/admin/orders", SHOP, HOST],
      ["/v1/admin/members", SHOP, HOST],
      ["/v1/admin/products", SHOP, HOST],
      ["/v1/admin/discount-codes", SHOP, HOST],
      ["/v1/admin/settings", SHOP, HOST],
      ["/v1/platform/tenants", undefined, PLATFORM_HOST],
      ["/v1/platform/users", undefined, PLATFORM_HOST],
    ] as const) {
      const response = await worker.fetch(
        request(path, affiliate, { host, ...(shopId === undefined ? {} : { shopId }) }),
        env,
      );
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: { code: "not_found", message: "Route not found" } });
    }
  });
});

interface CapturedQueue {
  queue: Queue;
  sent: unknown[];
}

function captureQueue(): CapturedQueue {
  const sent: unknown[] = [];
  return {
    queue: {
      async send(body: unknown) {
        sent.push(body);
      },
      async sendBatch() {
        throw new Error("not used");
      },
    } as unknown as Queue,
    sent,
  };
}

function envWith(overrides: Record<PropertyKey, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

const CONTEXT = {
  code: "WELCOME1",
  commissionBp: 1500,
  discountBp: 1000,
  portalUrl: `${TEST_ORIGINS.admin}/affiliate?shopId=${SHOP}`,
  refLink: `${TEST_ORIGINS.web}/${SHOP}/?ref=WELCOME1`,
  shopName: "Affid Shop",
};

describe("the affiliate invite (the reset mechanism, the shop's words)", () => {
  it("queues an affiliate_invite naming the shop; its link is single use and lands on the admin reset page", async () => {
    const created = await createInvitedUser(
      env,
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      { accountType: "affiliate", email: "invited@affid.test", name: "Invited" },
      Date.now(),
    );
    expect(created.status).toBe("ok");
    const userId = created.status === "ok" ? created.user.userId : "";
    const captured = captureQueue();
    const result = await issueInvite(
      envWith({ EMAIL_QUEUE: captured.queue }),
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      userId,
      Date.now(),
      { affiliate: CONTEXT, locale: "en" },
    );
    expect(result).toMatchObject({ invite: { surface: "admin", userId }, status: "ok" });
    expect(captured.sent).toHaveLength(1);
    const job = parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL) as AuthEmailJob & {
      affiliate?: unknown;
      variant?: string;
    };
    expect(job).toMatchObject({ affiliate: CONTEXT, kind: "password_reset", locale: "en", variant: "affiliate_invite" });

    const token = new URL(job.actionUrl).pathname.split("/").at(-1) as string;
    const followed = await worker.fetch(new Request(job.actionUrl, { redirect: "manual" }), env);
    expect(new URL(followed.headers.get("location") ?? "").origin).toBe(
      new URL(passwordResetCallbackUrl(TEST_ORIGINS, "admin")).origin,
    );
    const set = (newPassword: string) =>
      worker.fetch(
        new Request(`${AUTH_ORIGIN}/api/auth/reset-password`, {
          body: JSON.stringify({ newPassword, token }),
          headers: { "content-type": "application/json", origin: RESET_ORIGIN },
          method: "POST",
        }),
        env,
      );
    expect((await set(NEW_PASSWORD)).status).toBe(200);
    expect((await set("another-password-long-enough")).status).toBe(400);
    expect((await signIn("invited@affid.test", NEW_PASSWORD)).status).toBe(200);
  });

  it("is refused for an identity that is not an affiliate", async () => {
    const captured = captureQueue();
    const result = await issueInvite(
      envWith({ EMAIL_QUEUE: captured.queue }),
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      shopAdmin.userId,
      Date.now(),
      { affiliate: CONTEXT },
    );
    expect(result).toEqual({ status: "not_invitable" });
    expect(captured.sent).toHaveLength(0);
  });
});

describe("one address, one kind (A2) — and the unaccepted affiliate (R2-6)", () => {
  function inviteAdmin(email: string, options: { env?: Env } = {}): Promise<Response> {
    return worker.fetch(
      request("/v1/admin/members", shopAdmin, { body: { email, name: "New Admin" }, method: "POST", shopId: SHOP }),
      options.env ?? envWith({ EMAIL_QUEUE: captureQueue().queue }),
    );
  }

  it("converts an affiliate who never set a password and holds no ledger row into the invited tenant admin", async () => {
    const created = await createInvitedUser(
      env,
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      { accountType: "affiliate", email: "squatted@affid.test", name: "Squatted" },
      Date.now(),
    );
    const userId = created.status === "ok" ? created.user.userId : "";
    await seedAffiliate({ code: "SQUAT10", tenantId: SHOP_B, userId });
    await seedAffiliateMembership(SHOP_B, userId);

    const response = await inviteAdmin("squatted@affid.test");
    expect(response.status).toBe(201);
    const identity = await env.DB.prepare("SELECT account_type FROM identity_access WHERE user_id = ?")
      .bind(userId)
      .first<{ account_type: string }>();
    expect(identity?.account_type).toBe("tenant_admin");
    expect(
      await count("SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ? AND role = 'affiliate' AND status = 'active'", userId),
    ).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM affiliates WHERE user_id = ? AND status = 'inactive'", userId)).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'identity.convert_unaccepted_affiliate' AND resource_id = ?", userId),
    ).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ? AND tenant_id = ? AND role = 'admin' AND status = 'active'", userId, SHOP),
    ).toBe(1);
  });

  it("keeps an affiliate who HAS set a password not_addable, and the platform's provisioning answers conflict for it", async () => {
    const response = await inviteAdmin(affiliate.email);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "not_addable", message: "The address cannot be added to this shop" },
    });
    const platform = await worker.fetch(
      request("/v1/platform/users", platformAdmin, {
        body: { accountType: "tenant_admin", email: affiliate.email },
        host: PLATFORM_HOST,
        method: "POST",
      }),
      env,
    );
    expect(platform.status).toBe(409);
    const identity = await env.DB.prepare("SELECT account_type FROM identity_access WHERE user_id = ?")
      .bind(affiliate.userId)
      .first<{ account_type: string }>();
    expect(identity?.account_type).toBe("affiliate");
  });

  it("keeps an unaccepted affiliate WITH a ledger row not_addable (it is money's, not a squat)", async () => {
    const created = await createInvitedUser(
      env,
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      { accountType: "affiliate", email: "earner@affid.test", name: "Earner" },
      Date.now(),
    );
    const userId = created.status === "ok" ? created.user.userId : "";
    const { affiliateId: earner } = await seedAffiliate({ code: "EARNER1", tenantId: SHOP, userId });
    await env.DB.prepare(
      `INSERT INTO affiliate_ledger (entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, ref, reason, created_by, created_at)
       VALUES (?, ?, ?, 'adjustment', 100, 'SEK', ?, 'Start', 'test', ?)`,
    )
      .bind(crypto.randomUUID(), SHOP, earner, crypto.randomUUID(), new Date().toISOString())
      .run();
    expect((await inviteAdmin("earner@affid.test")).status).toBe(409);
  });

  it("the platform's provisioning converts an unaccepted affiliate address too", async () => {
    const created = await createInvitedUser(
      env,
      { accountType: "tenant_admin", role: "admin", tenantId: SHOP, userId: shopAdmin.userId },
      { accountType: "affiliate", email: "console@affid.test", name: "Console" },
      Date.now(),
    );
    const userId = created.status === "ok" ? created.user.userId : "";
    const response = await worker.fetch(
      request("/v1/platform/users", platformAdmin, {
        body: { accountType: "tenant_admin", email: "console@affid.test" },
        host: PLATFORM_HOST,
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      user: { accountType: "tenant_admin", email: "console@affid.test", userId },
    });
  });
});
