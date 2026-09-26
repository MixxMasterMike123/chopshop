import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";
import {
  authorizePlatformRequest,
  authorizeTenantAdminRequest,
  resolveSessionIdentity,
  revokeUserSessions,
} from "../src/auth/request-authorization";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const NOW = 1_787_000_000_000;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

// One password for every fixture identity: sign-up and the sign-in that
// follows it must agree, so the value lives in one place.
const FIXTURE_PASSWORD = "test-password-long-enough";

async function signUp(email: string): Promise<SignedUpUser> {
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: email,
        password: FIXTURE_PASSWORD,
      }),
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
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const setCookie = signedIn.headers.get("set-cookie");

  expect(signedIn.status).toBe(200);
  expect(setCookie).not.toBeNull();
  if (setCookie === null) {
    throw new Error("Better Auth sign-in did not return a session cookie");
  }

  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("Better Auth returned an invalid session cookie");
  }

  return {
    cookie,
    userId: body.user.id,
  };
}

function authenticatedRequest(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } });
}

async function seedAccess(userId: string, accountType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (
      user_id, account_type, status, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, NOW, NOW)
    .run();
}

async function seedTenantAdmin(
  userId: string,
  tenantId: string,
  hostname: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
      ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, tenantId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_memberships (
        membership_id, tenant_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    ).bind(`membership-${tenantId}`, tenantId, userId, NOW, NOW),
  ]);
}

describe("session-to-live-principal authorization", () => {
  it("resolves a real Better Auth session without caching authorization", async () => {
    const signedUp = await signUp("platform-session@example.test");
    await seedAccess(signedUp.userId, "platform_admin");
    const request = authenticatedRequest(`${AUTH_ORIGIN}/platform`, signedUp.cookie);

    await expect(resolveSessionIdentity(env, request)).resolves.toEqual({
      userId: signedUp.userId,
    });
    await expect(authorizePlatformRequest(env, request)).resolves.toEqual({
      accountType: "platform_admin",
      userId: signedUp.userId,
    });

    await env.DB.prepare(
      "UPDATE identity_access SET status = 'revoked', updated_at = ? WHERE user_id = ?",
    )
      .bind(NOW + 1, signedUp.userId)
      .run();

    await expect(authorizePlatformRequest(env, request)).resolves.toBeNull();
  });

  /**
   * CONTRACT CHANGE (CP1, PLAN §2.1): the active shop is the one the request
   * NAMES in X-Shop-Id, checked against the session's live memberships. The
   * hostname used to decide it; it no longer takes part at all, so this test
   * sends every request to one shared admin host and lets only the header vary.
   */
  it("binds tenant authorization to the session and the X-Shop-Id it names", async () => {
    const signedUp = await signUp("tenant-session@example.test");
    await seedAccess(signedUp.userId, "tenant_admin");
    await seedTenantAdmin(
      signedUp.userId,
      "tenant-session-a",
      "admin-a.session.test",
    );
    await seedTenantAdmin(
      signedUp.userId,
      "tenant-session-b",
      "admin-b.session.test",
    );
    await env.DB.prepare(
      "UPDATE tenant_memberships SET status = 'revoked', updated_at = ? WHERE tenant_id = ?",
    )
      .bind(NOW + 1, "tenant-session-b")
      .run();

    const onSharedHost = (shopId: string | null): Request => {
      const request = authenticatedRequest(
        "https://admin.session.test/products",
        signedUp.cookie,
      );
      if (shopId !== null) {
        request.headers.set("x-shop-id", shopId);
      }
      return request;
    };

    await expect(
      authorizeTenantAdminRequest(env, onSharedHost("tenant-session-a")),
    ).resolves.toEqual({
      accountType: "tenant_admin",
      role: "admin",
      tenantId: "tenant-session-a",
      userId: signedUp.userId,
    });
    // Revoked membership, no header, malformed header, unknown shop.
    await expect(
      authorizeTenantAdminRequest(env, onSharedHost("tenant-session-b")),
    ).resolves.toBeNull();
    await expect(
      authorizeTenantAdminRequest(env, onSharedHost(null)),
    ).resolves.toBeNull();
    await expect(
      authorizeTenantAdminRequest(env, onSharedHost("TENANT-SESSION-A")),
    ).resolves.toBeNull();
    await expect(
      authorizeTenantAdminRequest(env, onSharedHost("tenant-session-zzz")),
    ).resolves.toBeNull();

    // The hostname carries no authority any more: shop A's own admin host with
    // no header is refused, and shop B's host naming shop A is accepted.
    await expect(
      authorizeTenantAdminRequest(
        env,
        authenticatedRequest(
          "https://admin-a.session.test/products",
          signedUp.cookie,
        ),
      ),
    ).resolves.toBeNull();
    const viaOtherHost = authenticatedRequest(
      "https://admin-b.session.test/products",
      signedUp.cookie,
    );
    viaOtherHost.headers.set("x-shop-id", "tenant-session-a");
    await expect(
      authorizeTenantAdminRequest(env, viaOtherHost),
    ).resolves.toMatchObject({ tenantId: "tenant-session-a" });
  });

  it("invalidates the session after server-side revocation", async () => {
    const signedUp = await signUp("revoked-session@example.test");
    const request = authenticatedRequest(`${AUTH_ORIGIN}/account`, signedUp.cookie);

    await expect(resolveSessionIdentity(env, request)).resolves.toEqual({
      userId: signedUp.userId,
    });
    await expect(revokeUserSessions(env.DB, signedUp.userId)).resolves.toBe(1);
    await expect(resolveSessionIdentity(env, request)).resolves.toBeNull();
  });

  it("rejects requests without a valid session", async () => {
    const request = new Request(`${AUTH_ORIGIN}/platform`);

    await expect(resolveSessionIdentity(env, request)).resolves.toBeNull();
    await expect(authorizePlatformRequest(env, request)).resolves.toBeNull();
  });
});
