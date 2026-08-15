import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.platformshop.test";
const PLATFORM_TENANT = "tenant-platform-console";
const NOW = 1_787_300_000_000;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

interface TenantBody {
  tenant: {
    defaultCurrency: string;
    defaultLocale: string;
    shopName: string;
    status: string;
    tenantId: string;
  };
}

interface DomainBody {
  domain: {
    domainId: string;
    hostname: string;
    kind: string;
    status: string;
  };
}

interface MembershipBody {
  membership: {
    membershipId: string;
    role: string;
    status: string;
    tenantId: string;
    userId: string;
  };
}

let platformAdmin: SignedUpUser;
let tenantAdmin: SignedUpUser;
let ordinary: SignedUpUser;
let grantee: SignedUpUser;

async function signUp(email: string): Promise<SignedUpUser> {
  // Better Auth caps /sign-up at 3 requests per 10s in a shared bucket when no
  // client IP is forwarded. This suite needs four fixtures, so drain the
  // rate-limit ledger between them instead of sleeping through the window.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: email,
        password: "test-password-long-enough",
      }),
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
      },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  const setCookie = response.headers.get("set-cookie");

  expect(response.status).toBe(200);
  if (setCookie === null) {
    throw new Error("Better Auth sign-up did not return a session cookie");
  }

  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("Better Auth returned an invalid session cookie");
  }

  return { cookie, userId: body.user.id };
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

async function provisionTenant(
  body: Record<string, unknown>,
  options: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  return exports.default.fetch(
    platformRequest(`${PLATFORM_HOST}/v1/platform/tenants`, "POST", {
      body,
      cookie: options.cookie === undefined ? platformAdmin.cookie : options.cookie,
      origin: options.origin,
    }),
  );
}

async function countTenants(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM tenants",
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function countDomains(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM tenant_domains",
  ).first<{ total: number }>();

  return row?.total ?? 0;
}

async function countMemberships(tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM tenant_memberships WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

async function auditActions(tenantId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT action
     FROM audit_events
     WHERE tenant_id = ?
     ORDER BY created_at ASC, event_id ASC`,
  )
    .bind(tenantId)
    .all<{ action: string }>();

  return result.results.map((row) => row.action);
}

async function storefrontName(host: string): Promise<string | null> {
  const response = await exports.default.fetch(`${host}/v1/storefront`);
  if (response.status !== 200) {
    return null;
  }

  const body = await response.json<{ storefront: { name: string } }>();
  return body.storefront.name;
}

beforeAll(async () => {
  platformAdmin = await signUp("platform-admin@platformshop.test");
  tenantAdmin = await signUp("tenant-admin@platformshop.test");
  ordinary = await signUp("ordinary@platformshop.test");
  grantee = await signUp("grantee@platformshop.test");

  await seedAccess(platformAdmin.userId, "platform_admin");
  await seedAccess(tenantAdmin.userId, "tenant_admin");
  await seedAccess(ordinary.userId, "ordinary");

  // The platform console itself is served from a tenant-owned admin hostname,
  // so the same-origin check has a real origin to compare against.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency,
        created_at, updated_at
      ) VALUES (?, 'active', 'Platform Console', 'sv-SE', 'SEK', ?, ?)`,
    ).bind(PLATFORM_TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, 'console.platformshop.test', 'platform', 'verified', ?, ?)`,
    ).bind(`domain-${PLATFORM_TENANT}`, PLATFORM_TENANT, NOW, NOW),
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

describe("platform tenant provisioning lifecycle", () => {
  it("provisions a tenant that immediately serves its storefront", async () => {
    const response = await provisionTenant({
      hostname: "shop.lifecycle.test",
      shopName: "Lifecycle Shop",
      tenantId: "lifecycle-shop",
    });
    const body = await response.json<TenantBody>();

    expect(response.status).toBe(201);
    expect(body.tenant).toEqual({
      defaultCurrency: "SEK",
      defaultLocale: "sv-SE",
      shopName: "Lifecycle Shop",
      status: "active",
      tenantId: "lifecycle-shop",
    });
    await expect(storefrontName("https://shop.lifecycle.test")).resolves.toBe(
      "Lifecycle Shop",
    );

    const suspended = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/lifecycle-shop/suspend`,
        "POST",
        { cookie: platformAdmin.cookie },
      ),
    );
    expect(suspended.status).toBe(200);
    await expect(suspended.json()).resolves.toMatchObject({
      tenant: { status: "suspended" },
    });
    await expect(
      storefrontName("https://shop.lifecycle.test"),
    ).resolves.toBeNull();

    const activated = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/lifecycle-shop/activate`,
        "POST",
        { cookie: platformAdmin.cookie },
      ),
    );
    expect(activated.status).toBe(200);
    await expect(storefrontName("https://shop.lifecycle.test")).resolves.toBe(
      "Lifecycle Shop",
    );

    expect(await auditActions("lifecycle-shop")).toEqual([
      "tenant.provision",
      "tenant.suspend",
      "tenant.activate",
    ]);
  });

  it("treats a repeated status change as idempotent", async () => {
    await provisionTenant({
      hostname: "shop.idempotent.test",
      shopName: "Idempotent Shop",
      tenantId: "idempotent-shop",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await exports.default.fetch(
        platformRequest(
          `${PLATFORM_HOST}/v1/platform/tenants/idempotent-shop/suspend`,
          "POST",
          { cookie: platformAdmin.cookie },
        ),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        tenant: { status: "suspended" },
      });
    }

    await expect(
      env.DB.prepare("SELECT status FROM tenants WHERE tenant_id = ?")
        .bind("idempotent-shop")
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "suspended" });
  });

  it("honours explicit locale and currency overrides", async () => {
    const response = await provisionTenant({
      defaultCurrency: "EUR",
      defaultLocale: "fi-FI",
      hostname: "Shop.Locale.Test.",
      shopName: "Locale Shop",
      tenantId: "locale-shop",
    });
    const body = await response.json<TenantBody>();

    expect(response.status).toBe(201);
    expect(body.tenant).toMatchObject({
      defaultCurrency: "EUR",
      defaultLocale: "fi-FI",
    });

    // The hostname is normalized before storage, so the mixed-case request
    // resolves on the canonical lowercase host.
    await expect(storefrontName("https://shop.locale.test")).resolves.toBe(
      "Locale Shop",
    );
  });

  it("never leaks internal tenant columns", async () => {
    await env.DB.prepare(
      `UPDATE tenants
       SET support_email = ?, settings_json = ?, updated_at = ?
       WHERE tenant_id = ?`,
    )
      .bind(
        "secret-support@lifecycle.test",
        '{"secret":"internal"}',
        NOW + 1,
        "lifecycle-shop",
      )
      .run();

    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/lifecycle-shop/activate`,
        "POST",
        { cookie: platformAdmin.cookie },
      ),
    );
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain("secret-support@lifecycle.test");
    expect(raw).not.toContain("settings_json");
    expect(raw).not.toContain("createdAt");
    expect(raw).not.toContain("created_at");
  });
});

describe("platform tenant domains", () => {
  it("adds an admin domain to an existing tenant", async () => {
    await provisionTenant({
      hostname: "shop.domains.test",
      shopName: "Domains Shop",
      tenantId: "domains-shop",
    });

    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/domains-shop/domains`,
        "POST",
        {
          body: { hostname: "admin.domains.test", kind: "admin" },
          cookie: platformAdmin.cookie,
        },
      ),
    );
    const body = await response.json<DomainBody>();

    expect(response.status).toBe(201);
    expect(body.domain).toEqual({
      domainId: expect.any(String),
      hostname: "admin.domains.test",
      kind: "admin",
      status: "verified",
    });
    expect(await auditActions("domains-shop")).toEqual([
      "tenant.provision",
      "tenant.domain_add",
    ]);
  });

  it("rejects a domain for an unknown or suspended tenant", async () => {
    const unknown = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/no-such-tenant/domains`,
        "POST",
        {
          body: { hostname: "ghost.domains.test", kind: "admin" },
          cookie: platformAdmin.cookie,
        },
      ),
    );
    expect(unknown.status).toBe(404);

    const suspended = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/idempotent-shop/domains`,
        "POST",
        {
          body: { hostname: "late.idempotent.test", kind: "admin" },
          cookie: platformAdmin.cookie,
        },
      ),
    );
    expect(suspended.status).toBe(404);

    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM tenant_domains WHERE hostname IN (?, ?)",
      )
        .bind("ghost.domains.test", "late.idempotent.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it("rejects a duplicate hostname across tenants", async () => {
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/domains-shop/domains`,
        "POST",
        {
          body: { hostname: "shop.lifecycle.test", kind: "storefront" },
          cookie: platformAdmin.cookie,
        },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: "conflict" } });
    expect(JSON.stringify(body)).not.toContain("UNIQUE");

    // The hostname still points at the tenant that claimed it first.
    await expect(
      env.DB.prepare("SELECT tenant_id FROM tenant_domains WHERE hostname = ?")
        .bind("shop.lifecycle.test")
        .first<{ tenant_id: string }>(),
    ).resolves.toEqual({ tenant_id: "lifecycle-shop" });
  });
});

describe("platform tenant admin grants", () => {
  it("lets a granted admin use the tenant admin write path", async () => {
    await provisionTenant({
      hostname: "shop.grant.test",
      shopName: "Grant Shop",
      tenantId: "grant-shop",
    });
    await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/domains`,
        "POST",
        {
          body: { hostname: "admin.grant.test", kind: "admin" },
          cookie: platformAdmin.cookie,
        },
      ),
    );

    const granted = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body: { userId: grantee.userId }, cookie: platformAdmin.cookie },
      ),
    );
    const body = await granted.json<MembershipBody>();

    expect(granted.status).toBe(201);
    expect(body.membership).toEqual({
      membershipId: expect.any(String),
      role: "admin",
      status: "active",
      tenantId: "grant-shop",
      userId: grantee.userId,
    });

    const created = await exports.default.fetch(
      platformRequest("https://admin.grant.test/v1/admin/products", "POST", {
        body: {
          currency: "SEK",
          name: "Granted Product",
          priceMinor: 1_000,
          sku: "SKU-GRANTED",
        },
        cookie: grantee.cookie,
      }),
    );

    expect(created.status).toBe(201);
  });

  it("treats a duplicate grant as idempotent success", async () => {
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body: { userId: grantee.userId }, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(201);
    await expect(countMemberships("grant-shop")).resolves.toBe(1);
  });

  it("refuses to convert an ordinary identity into a tenant admin", async () => {
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body: { userId: ordinary.userId }, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(409);
    await expect(
      env.DB.prepare("SELECT account_type FROM identity_access WHERE user_id = ?")
        .bind(ordinary.userId)
        .first<{ account_type: string }>(),
    ).resolves.toEqual({ account_type: "ordinary" });
    await expect(countMemberships("grant-shop")).resolves.toBe(1);
  });

  it("refuses to silently re-enable a revoked identity", async () => {
    const revoked = await signUp("revoked-grantee@platformshop.test");
    await env.DB.prepare(
      `INSERT INTO identity_access (
        user_id, account_type, status, created_at, updated_at
      ) VALUES (?, 'tenant_admin', 'revoked', ?, ?)`,
    )
      .bind(revoked.userId, NOW, NOW)
      .run();

    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body: { userId: revoked.userId }, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(409);
    await expect(
      env.DB.prepare("SELECT status FROM identity_access WHERE user_id = ?")
        .bind(revoked.userId)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "revoked" });
  });

  it("returns 404 for an unknown user id", async () => {
    const before = await countMemberships("grant-shop");
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body: { userId: "no-such-user" }, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(404);
    await expect(countMemberships("grant-shop")).resolves.toBe(before);
  });

  it("binds the granted user through the membership row, not audit metadata", async () => {
    const row = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json, resource_id, resource_type
       FROM audit_events
       WHERE tenant_id = 'grant-shop'
         AND action = 'tenant.admin_grant'
       LIMIT 1`,
    ).first<{
      actor_user_id: string | null;
      metadata_json: string | null;
      resource_id: string | null;
      resource_type: string;
    }>();

    expect(row?.actor_user_id).toBe(platformAdmin.userId);
    expect(row?.resource_type).toBe("tenant_membership");
    expect(row?.metadata_json).toBeNull();

    await expect(
      env.DB.prepare(
        "SELECT user_id FROM tenant_memberships WHERE membership_id = ?",
      )
        .bind(row?.resource_id)
        .first<{ user_id: string }>(),
    ).resolves.toEqual({ user_id: grantee.userId });
  });
});

describe("platform provisioning authorization", () => {
  it("hides the surface from anonymous callers", async () => {
    const before = await countTenants();
    const response = await exports.default.fetch(
      platformRequest(`${PLATFORM_HOST}/v1/platform/tenants`, "POST", {
        body: { hostname: "anon.deny.test", shopName: "Anon", tenantId: "anon" },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    await expect(countTenants()).resolves.toBe(before);
  });

  it("hides the surface from an ordinary signed-in user", async () => {
    const before = await countTenants();
    const response = await provisionTenant(
      {
        hostname: "ordinary.deny.test",
        shopName: "Ordinary",
        tenantId: "ordinary-deny",
      },
      { cookie: ordinary.cookie },
    );

    expect(response.status).toBe(404);
    await expect(countTenants()).resolves.toBe(before);
  });

  it("hides the surface from a tenant admin who is not a platform admin", async () => {
    const before = await countTenants();
    const response = await provisionTenant(
      {
        hostname: "tenant.deny.test",
        shopName: "Tenant Admin",
        tenantId: "tenant-deny",
      },
      { cookie: tenantAdmin.cookie },
    );

    expect(response.status).toBe(404);
    await expect(countTenants()).resolves.toBe(before);
    await expect(countDomains()).resolves.not.toBe(0);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS total FROM tenant_domains WHERE hostname = ?")
        .bind("tenant.deny.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
  });

  it.each([
    ["missing", null],
    ["cross-site", "https://evil.test"],
  ])("rejects a %s Origin even with a valid platform session", async (
    label,
    origin,
  ) => {
    const before = await countTenants();
    const response = await provisionTenant(
      {
        hostname: `csrf-${label}.deny.test`,
        shopName: `Csrf ${label}`,
        tenantId: `csrf-${label}`,
      },
      { origin },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    await expect(countTenants()).resolves.toBe(before);
  });

  it("does not expose the collection through another method", async () => {
    const response = await exports.default.fetch(
      platformRequest(`${PLATFORM_HOST}/v1/platform/tenants`, "GET", {
        cookie: platformAdmin.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ["https://console.platformshop.test/v1/platform/tenants/"],
    ["https://console.platformshop.test/v1/platform/tenants/grant-shop"],
    ["https://console.platformshop.test/v1/platform/tenants/grant-shop/delete"],
    [
      "https://console.platformshop.test/v1/platform/tenants/grant-shop/domains/extra",
    ],
  ])("rejects malformed platform path %s", async (target) => {
    const response = await exports.default.fetch(
      platformRequest(target, "POST", { cookie: platformAdmin.cookie }),
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for a status change on an unknown tenant", async () => {
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/never-provisioned/suspend`,
        "POST",
        { cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(404);
  });
});

describe("platform provisioning validation", () => {
  it.each([
    [
      "uppercase tenant id",
      { hostname: "bad1.deny.test", shopName: "Bad", tenantId: "Bad-Tenant" },
    ],
    [
      "dotted tenant id",
      { hostname: "bad2.deny.test", shopName: "Bad", tenantId: "bad.tenant" },
    ],
    [
      "leading hyphen tenant id",
      { hostname: "bad3.deny.test", shopName: "Bad", tenantId: "-bad-tenant" },
    ],
    [
      "empty tenant id",
      { hostname: "bad4.deny.test", shopName: "Bad", tenantId: "" },
    ],
    [
      "long tenant id",
      {
        hostname: "bad5.deny.test",
        shopName: "Bad",
        tenantId: `t${"e".repeat(64)}`,
      },
    ],
    [
      "double dot hostname",
      { hostname: "evil..test", shopName: "Bad", tenantId: "bad-host-1" },
    ],
    [
      "trailing hyphen label",
      { hostname: "evil-.test", shopName: "Bad", tenantId: "bad-host-2" },
    ],
    [
      "leading hyphen label",
      { hostname: "-evil.test", shopName: "Bad", tenantId: "bad-host-3" },
    ],
    [
      "underscore hostname",
      { hostname: "ev_il.test", shopName: "Bad", tenantId: "bad-host-4" },
    ],
    [
      "hostname with port",
      { hostname: "evil.test:8080", shopName: "Bad", tenantId: "bad-host-5" },
    ],
    [
      "overlong hostname",
      {
        hostname: `${"label.".repeat(42)}test`,
        shopName: "Bad",
        tenantId: "bad-host-6",
      },
    ],
    [
      "empty hostname",
      { hostname: "", shopName: "Bad", tenantId: "bad-host-7" },
    ],
    [
      "empty shop name",
      { hostname: "bad6.deny.test", shopName: "", tenantId: "bad-name-1" },
    ],
    [
      "long shop name",
      {
        hostname: "bad7.deny.test",
        shopName: "n".repeat(201),
        tenantId: "bad-name-2",
      },
    ],
    [
      "bad locale",
      {
        defaultLocale: "sv_SE",
        hostname: "bad8.deny.test",
        shopName: "Bad",
        tenantId: "bad-locale",
      },
    ],
    [
      "lowercase currency",
      {
        defaultCurrency: "sek",
        hostname: "bad9.deny.test",
        shopName: "Bad",
        tenantId: "bad-currency",
      },
    ],
    [
      "unknown key",
      {
        hostname: "bad10.deny.test",
        shopName: "Bad",
        status: "active",
        tenantId: "bad-unknown-key",
      },
    ],
    ["missing hostname", { shopName: "Bad", tenantId: "bad-missing-host" }],
    ["missing shop name", { hostname: "bad11.deny.test", tenantId: "bad-missing-name" }],
  ])("rejects provisioning with %s", async (_label, body) => {
    const before = await countTenants();
    const response = await provisionTenant(body);
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(responseBody)).not.toContain("deny.test");
    expect(JSON.stringify(responseBody)).not.toContain("Bad");
    await expect(countTenants()).resolves.toBe(before);
  });

  it("rejects a malformed JSON body", async () => {
    const response = await exports.default.fetch(
      platformRequest(`${PLATFORM_HOST}/v1/platform/tenants`, "POST", {
        body: "{not json",
        cookie: platformAdmin.cookie,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it.each([
    ["unknown kind", { hostname: "kind.deny.test", kind: "platform" }],
    ["missing kind", { hostname: "kind.deny.test" }],
    ["unknown key", { hostname: "kind.deny.test", kind: "admin", verified: true }],
    ["bad hostname", { hostname: "kind..deny.test", kind: "admin" }],
  ])("rejects a domain add with %s", async (_label, body) => {
    const before = await countDomains();
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/domains-shop/domains`,
        "POST",
        { body, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(400);
    await expect(countDomains()).resolves.toBe(before);
  });

  it.each([
    ["numeric user id", { userId: 42 }],
    ["empty user id", { userId: "" }],
    ["long user id", { userId: "u".repeat(129) }],
    ["unknown key", { role: "admin", userId: "someone" }],
    ["missing user id", {}],
  ])("rejects an admin grant with %s", async (_label, body) => {
    const before = await countMemberships("grant-shop");
    const response = await exports.default.fetch(
      platformRequest(
        `${PLATFORM_HOST}/v1/platform/tenants/grant-shop/admins`,
        "POST",
        { body, cookie: platformAdmin.cookie },
      ),
    );

    expect(response.status).toBe(400);
    await expect(countMemberships("grant-shop")).resolves.toBe(before);
  });

  it("rejects a duplicate tenant id", async () => {
    const response = await provisionTenant({
      hostname: "second.lifecycle.test",
      shopName: "Duplicate",
      tenantId: "lifecycle-shop",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: "conflict" } });
    expect(JSON.stringify(body)).not.toContain("UNIQUE");

    // The failed batch left no orphan domain behind.
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM tenant_domains WHERE hostname = ?",
      )
        .bind("second.lifecycle.test")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.DB.prepare("SELECT shop_name FROM tenants WHERE tenant_id = ?")
        .bind("lifecycle-shop")
        .first<{ shop_name: string }>(),
    ).resolves.toEqual({ shop_name: "Lifecycle Shop" });
  });

  it("rejects a tenant whose hostname is already claimed", async () => {
    const before = await countTenants();
    const response = await provisionTenant({
      hostname: "shop.lifecycle.test",
      shopName: "Hostname Thief",
      tenantId: "hostname-thief",
    });

    expect(response.status).toBe(409);
    await expect(countTenants()).resolves.toBe(before);
  });
});
