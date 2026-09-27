import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { createAuth } from "../src/auth/create-auth";
import { authorizePlatformAdmin } from "../src/auth/live-authorization";
import type { PlatformPrincipal } from "../src/auth/live-authorization";
import { deactivateUser } from "../src/platform/user-lifecycle";

/**
 * CP3-B — deactivate, reactivate, membership revoke. Every assertion about
 * access is made through a real request with the real session cookie, the way
 * a client would find out.
 */

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.lifecycle.example.com";
const ADMIN_HOST = "https://admin.lifecycle.example.com";
const SHOP_A = "lifecycle-shop-a";
const SHOP_B = "lifecycle-shop-b";
const NOW = 1_789_000_000_000;
const PASSWORD = "test-password-long-enough";

interface Person {
  cookie: string;
  email: string;
  userId: string;
}

let operator: Person;
let colleague: Person;
let shopAdmin: Person;
let soloAdmin: Person;
let productCounter = 0;

async function drainAuthLimiter(): Promise<void> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
}

async function signInResponse(email: string): Promise<Response> {
  await drainAuthLimiter();
  return createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
}

async function signIn(email: string): Promise<string> {
  const response = await signInResponse(email);
  expect(response.status).toBe(200);
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
  return { cookie: await signIn(email), email, userId: body.user.id };
}

async function seedAccess(userId: string, accountType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, NOW, NOW)
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

async function seedMembership(tenantId: string, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), tenantId, userId, NOW, NOW)
    .run();
}

function platformCall(
  method: string,
  path: string,
  options: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ cookie: options.cookie ?? operator.cookie });
  const origin = options.origin === undefined ? PLATFORM_HOST : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return worker.fetch(new Request(`${PLATFORM_HOST}${path}`, { headers, method }), env);
}

/** A tenant-admin write: 201 when the session may act on the shop, 404 otherwise. */
function createProduct(cookie: string, shopId: string): Promise<Response> {
  productCounter += 1;
  return worker.fetch(
    new Request(`${ADMIN_HOST}/v1/admin/products`, {
      body: JSON.stringify({
        currency: "SEK",
        name: `Lifecycle Product ${productCounter}`,
        priceMinor: 10_000,
        sku: `LIFECYCLE-${productCounter}`,
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        origin: ADMIN_HOST,
        "x-shop-id": shopId,
      },
      method: "POST",
    }),
    env,
  );
}

async function hasSession(cookie: string): Promise<boolean> {
  const response = await worker.fetch(
    new Request(`${AUTH_ORIGIN}/api/auth/get-session`, {
      headers: { cookie, origin: AUTH_ORIGIN },
    }),
    env,
  );
  return (await response.json()) !== null;
}

async function accessStatus(userId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM identity_access WHERE user_id = ?")
    .bind(userId)
    .first<{ status: string }>();
  return row?.status;
}

async function activePlatformAdmins(): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT user_id FROM identity_access
     WHERE account_type = 'platform_admin' AND status = 'active'
     ORDER BY user_id`,
  ).all<{ user_id: string }>();
  return rows.results.map((row) => row.user_id);
}

async function setStatus(userId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE identity_access SET status = ? WHERE user_id = ?")
    .bind(status, userId)
    .run();
}

async function auditRows(action: string, resourceId: string) {
  const rows = await env.DB.prepare(
    `SELECT actor_user_id, tenant_id, resource_type, metadata_json
     FROM audit_events WHERE action = ? AND resource_id = ?
     ORDER BY created_at`,
  )
    .bind(action, resourceId)
    .all<{
      actor_user_id: string;
      metadata_json: string;
      resource_type: string;
      tenant_id: string | null;
    }>();
  return rows.results;
}

async function principalOf(person: Person): Promise<PlatformPrincipal> {
  const principal = await authorizePlatformAdmin(env.DB, person.userId);
  if (principal === null) {
    throw new Error("fixture is not an active platform admin");
  }
  return principal;
}

beforeAll(async () => {
  await seedTenant(SHOP_A);
  await seedTenant(SHOP_B);

  operator = await signUp("lifecycle-operator@example.com", "Test Operator");
  colleague = await signUp("lifecycle-colleague@example.com", "Test Colleague");
  shopAdmin = await signUp("lifecycle-admin@example.com", "Test Admin");
  soloAdmin = await signUp("lifecycle-solo@example.com", "Test Solo Admin");

  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(colleague.userId, "platform_admin");
  await seedAccess(shopAdmin.userId, "tenant_admin");
  await seedAccess(soloAdmin.userId, "tenant_admin");

  await seedMembership(SHOP_A, shopAdmin.userId);
  await seedMembership(SHOP_B, shopAdmin.userId);
  await seedMembership(SHOP_A, soloAdmin.userId);
});

describe("deactivate", () => {
  it("suspends the identity and its live session is refused on the very next request", async () => {
    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(201);
    expect(await hasSession(shopAdmin.cookie)).toBe(true);

    const response = await platformCall(
      "POST",
      `/v1/platform/users/${shopAdmin.userId}/deactivate`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { accountType: "tenant_admin", status: "suspended", userId: shopAdmin.userId },
    });

    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(404);
    expect((await createProduct(shopAdmin.cookie, SHOP_B)).status).toBe(404);
    expect(await hasSession(shopAdmin.cookie)).toBe(false);
    await expect(
      env.DB.prepare('SELECT COUNT(*) AS total FROM "session" WHERE "userId" = ?')
        .bind(shopAdmin.userId)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });

    // Memberships are untouched: deactivation is about the identity.
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM tenant_memberships WHERE user_id = ? AND status = 'active'",
      )
        .bind(shopAdmin.userId)
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 2 });

    const audits = await auditRows("platform.user_deactivate", shopAdmin.userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: operator.userId,
      resource_type: "identity_access",
      tenant_id: null,
    });
    const metadata = JSON.parse(audits[0]?.metadata_json as string);
    expect(metadata).toMatchObject({ accountType: "tenant_admin", invitesRevoked: 0 });
    expect(metadata.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain(shopAdmin.email);
  });

  it("refuses a second deactivation as a conflict, and records nothing", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/users/${shopAdmin.userId}/deactivate`,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_active", message: "The identity is not active" },
    });
    expect(await auditRows("platform.user_deactivate", shopAdmin.userId)).toHaveLength(1);
  });

  it("refuses self-deactivation", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/users/${operator.userId}/deactivate`,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "cannot_deactivate_self",
        message: "An operator cannot deactivate their own identity",
      },
    });
    expect(await accessStatus(operator.userId)).toBe("active");
    expect(await auditRows("platform.user_deactivate", operator.userId)).toHaveLength(0);
  });

  it("deactivates another platform admin, whose session dies with it", async () => {
    expect((await platformCall("GET", "/v1/platform/users", { cookie: colleague.cookie })).status).toBe(200);

    const response = await platformCall(
      "POST",
      `/v1/platform/users/${colleague.userId}/deactivate`,
    );
    expect(response.status).toBe(200);

    expect((await platformCall("GET", "/v1/platform/users", { cookie: colleague.cookie })).status).toBe(404);
    expect(await hasSession(colleague.cookie)).toBe(false);
  });

  it("answers 404 for an unknown user and 409 for a user with no identity", async () => {
    const unknown = await platformCall("POST", "/v1/platform/users/no-such-user/deactivate");
    expect(unknown.status).toBe(404);

    const bare = await signUp("lifecycle-bare@example.com", "Test Bare");
    const response = await platformCall("POST", `/v1/platform/users/${bare.userId}/deactivate`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "no_identity" } });
  });
});

describe("reactivate", () => {
  it("restores access through a NEW sign-in; the old session stays dead", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/users/${shopAdmin.userId}/reactivate`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { status: "active", userId: shopAdmin.userId },
    });

    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(404);

    shopAdmin.cookie = await signIn(shopAdmin.email);
    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(201);
    expect((await createProduct(shopAdmin.cookie, SHOP_B)).status).toBe(201);

    const audits = await auditRows("platform.user_reactivate", shopAdmin.userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_user_id).toBe(operator.userId);
  });

  it("refuses an identity that is not suspended", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/users/${shopAdmin.userId}/reactivate`,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_suspended" } });
  });

  it("refuses to bring a platform admin back over HTTP (D51)", async () => {
    expect(await accessStatus(colleague.userId)).toBe("suspended");
    const response = await platformCall(
      "POST",
      `/v1/platform/users/${colleague.userId}/reactivate`,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "platform_admin_reactivation",
        message: "A platform admin cannot be reactivated over HTTP",
      },
    });
    expect(await accessStatus(colleague.userId)).toBe("suspended");
    expect(await auditRows("platform.user_reactivate", colleague.userId)).toHaveLength(0);
  });
});

describe("membership revoke", () => {
  it("ends access to that shop on the next request and keeps every other shop", async () => {
    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(201);

    const response = await platformCall(
      "POST",
      `/v1/platform/tenants/${SHOP_A}/admins/${shopAdmin.userId}/revoke`,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ membership: { membershipId: string } }>();
    expect(body).toEqual({
      membership: {
        membershipId: expect.any(String),
        role: "admin",
        status: "revoked",
        tenantId: SHOP_A,
        userId: shopAdmin.userId,
      },
    });

    // Same session, same request shape: shop A is gone, shop B is not.
    expect((await createProduct(shopAdmin.cookie, SHOP_A)).status).toBe(404);
    expect((await createProduct(shopAdmin.cookie, SHOP_B)).status).toBe(201);
    expect(await hasSession(shopAdmin.cookie)).toBe(true);

    const audits = await auditRows("tenant.admin_revoke", body.membership.membershipId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: operator.userId,
      resource_type: "tenant_membership",
      tenant_id: SHOP_A,
    });

    const read = await platformCall("GET", `/v1/platform/users/${shopAdmin.userId}`);
    await expect(read.json()).resolves.toMatchObject({
      user: {
        memberships: [
          { role: "admin", status: "revoked", tenantId: SHOP_A },
          { role: "admin", status: "active", tenantId: SHOP_B },
        ],
        status: "active",
      },
    });
  });

  it("answers 409 for an already revoked membership and 404 for none", async () => {
    const again = await platformCall(
      "POST",
      `/v1/platform/tenants/${SHOP_A}/admins/${shopAdmin.userId}/revoke`,
    );
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: { code: "already_revoked" } });

    for (const path of [
      `/v1/platform/tenants/no-such-shop/admins/${shopAdmin.userId}/revoke`,
      `/v1/platform/tenants/${SHOP_B}/admins/${operator.userId}/revoke`,
      `/v1/platform/tenants/Bad.Shop/admins/${shopAdmin.userId}/revoke`,
    ]) {
      expect((await platformCall("POST", path)).status, path).toBe(404);
    }
  });

  it("leaves a tenant admin whose only membership is revoked with an account and no shop", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/tenants/${SHOP_A}/admins/${soloAdmin.userId}/revoke`,
    );
    expect(response.status).toBe(200);

    expect(await accessStatus(soloAdmin.userId)).toBe("active");
    expect((await signInResponse(soloAdmin.email)).status).toBe(200);
    expect((await createProduct(soloAdmin.cookie, SHOP_A)).status).toBe(404);
  });

  it("refuses a cross-site revoke", async () => {
    const response = await platformCall(
      "POST",
      `/v1/platform/tenants/${SHOP_B}/admins/${shopAdmin.userId}/revoke`,
      { origin: "https://evil.example.com" },
    );
    expect(response.status).toBe(404);
    expect((await createProduct(shopAdmin.cookie, SHOP_B)).status).toBe(201);
  });
});

describe("the last-platform-admin guard", () => {
  it("refuses to suspend the only active platform admin, even for a caller authorized a moment ago", async () => {
    // The race window, held open: the operator was authorized, and before the
    // write the operator was suspended by someone else. The colleague is then
    // the last active platform admin, and the guarded UPDATE must refuse.
    await setStatus(colleague.userId, "active");
    const stale = await principalOf(operator);
    await setStatus(operator.userId, "suspended");
    try {
      await expect(deactivateUser(env.DB, stale, colleague.userId, Date.now())).resolves.toEqual({
        reason: "last_platform_admin",
        status: "refused",
      });
      expect(await activePlatformAdmins()).toEqual([colleague.userId]);
      expect(await auditRows("platform.user_deactivate", colleague.userId)).toHaveLength(1);
    } finally {
      await setStatus(operator.userId, "active");
    }
  });

  it("holds when the last two admins deactivate each other concurrently (both already authorized)", async () => {
    for (let round = 0; round < 5; round += 1) {
      await setStatus(operator.userId, "active");
      await setStatus(colleague.userId, "active");
      expect(await activePlatformAdmins()).toEqual(
        [operator.userId, colleague.userId].sort(),
      );

      const [first, second] = await Promise.all([principalOf(operator), principalOf(colleague)]);
      const results = await Promise.all([
        deactivateUser(env.DB, first, colleague.userId, Date.now()),
        deactivateUser(env.DB, second, operator.userId, Date.now()),
      ]);

      expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
      expect(results.filter((result) => result.status === "refused")).toEqual([
        { reason: "last_platform_admin", status: "refused" },
      ]);
      expect(await activePlatformAdmins()).toHaveLength(1);
    }
    await setStatus(operator.userId, "active");
    await setStatus(colleague.userId, "active");
  });

  it("holds over HTTP: two crosswise requests end with exactly one active platform admin", async () => {
    await setStatus(operator.userId, "active");
    await setStatus(colleague.userId, "active");
    operator.cookie = await signIn(operator.email);
    colleague.cookie = await signIn(colleague.email);

    const responses = await Promise.all([
      platformCall("POST", `/v1/platform/users/${colleague.userId}/deactivate`, {
        cookie: operator.cookie,
      }),
      platformCall("POST", `/v1/platform/users/${operator.userId}/deactivate`, {
        cookie: colleague.cookie,
      }),
    ]);
    const statuses = responses.map((response) => response.status);

    // One wins. The loser is refused by the guard (409) or, if the winner's
    // batch landed before the loser was authorized, by the live session check
    // (404). Either way the platform keeps exactly one active admin.
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409 || status === 404)).toHaveLength(1);
    expect(await activePlatformAdmins()).toHaveLength(1);
  });
});
