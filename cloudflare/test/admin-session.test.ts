import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminFeatures } from "../src/routes/admin-session";
import {
  DELETED_FEATURE_KEYS,
  FEATURE_KEYS,
  NOT_PORTED_FEATURE_KEYS,
} from "../src/platform/tenant-config";
import { ADMIN, call, type CallOptions, PASSWORD, signIn } from "./slice-harness";
import {
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP5-WA — `GET /v1/me` and `GET /v1/admin/shop` (docs/cf-port/CP5_BRIEFS.md
 * §0.2), on the admin host. Every identity, membership and grant comes from
 * the real platform routes; a few states the routes cannot reach in a test
 * (an expired grant, a suspended identity) are written with SQL, as the
 * acting-as suite does.
 */

interface MeBody {
  accountType: string;
  actingAs: Array<{ expiresAt: string; shopName: string | null; tenantId: string }>;
  memberships: Array<{
    published: boolean;
    role: string;
    shopName: string | null;
    status: string;
    tenantId: string;
  }>;
  platform: boolean;
  user: { email: string; id: string; name: string };
}

interface ShopBody {
  shop: {
    currency: string;
    defaultLocale: string;
    features: Record<string, boolean>;
    published: boolean;
    shopName: string | null;
    status: string;
    supportEmail: string | null;
    tenantId: string;
    vatRateBp: number;
  };
}

const UNAUTHENTICATED = { error: { code: "unauthenticated" } };

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;
let shopD: Tenant;
/** Closed by its test and never reopened (a closed shop cannot be: 0032 trigger). */
let shopE: Tenant;

function me(options: CallOptions = {}): Promise<Response> {
  return call(world, "GET", `${ADMIN}/v1/me`, options);
}

function shop(cookie: string | undefined, shopId: string | undefined, options: CallOptions = {}) {
  return call(world, "GET", `${ADMIN}/v1/admin/shop`, { cookie, shopId, ...options });
}

async function readMe(cookie: string): Promise<MeBody> {
  return expectJson<MeBody>(await me({ cookie }), 200, "me");
}

async function expectUnauthenticated(response: Response, label: string): Promise<void> {
  expect(response.headers.get("cache-control"), label).toBe("no-store");
  expect(await expectJson(response, 401, label), label).toEqual(UNAUTHENTICATED);
}

/** A fresh tenant admin with a membership in each of `tenants`, signed in. */
async function newAdmin(label: string, tenants: Tenant[]): Promise<{ cookie: string; email: string; userId: string }> {
  const email = `${label}@wa.admin-session.test`;
  const created = await expectJson<{ user: { userId: string } }>(
    await platform(world, "POST", "/v1/platform/users", {
      body: { accountType: "tenant_admin", email, password: PASSWORD },
    }),
    201,
    `create ${label}`,
  );
  for (const tenant of tenants) {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${tenant.tenantId}/admins`, {
        body: { userId: created.user.userId },
      }),
      201,
      `grant ${label} on ${tenant.tenantId}`,
    );
  }
  return { cookie: await signIn(world, email), email, userId: created.user.userId };
}

async function openGrant(tenantId: string): Promise<string> {
  const body = await expectJson<{ expiresAt: string; tenantId: string }>(
    await platform(world, "POST", `/v1/platform/tenants/${tenantId}/acting-as`, {
      body: { reason: "CP5-WA test" },
    }),
    201,
    `acting-as ${tenantId}`,
  );
  return body.expiresAt;
}

async function closeGrants(tenantId: string): Promise<void> {
  await platform(world, "DELETE", `/v1/platform/tenants/${tenantId}/acting-as`);
}

async function insertGrant(tenantId: string, createdAt: string, expiresAt: string, revokedAt: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), world.platformUserId, tenantId, createdAt, expiresAt, revokedAt)
    .run();
}

async function setTenantStatus(tenantId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET status = ? WHERE tenant_id = ?").bind(status, tenantId).run();
}

async function setIdentityStatus(userId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE identity_access SET status = ? WHERE user_id = ?").bind(status, userId).run();
}

beforeAll(async () => {
  const setup = await tenantWorld("wa", 5);
  world = setup.world;
  [shopA, shopB, shopC, shopD, shopE] = setup.tenants as [Tenant, Tenant, Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/me refuses", () => {
  it("answers 401 unauthenticated, uncached, without a session", async () => {
    await expectUnauthenticated(await me(), "no cookie");
    await expectUnauthenticated(
      await me({ cookie: "better-auth.session_token=not-a-real-token" }),
      "forged cookie",
    );
  });

  it("answers 401 for an account type the admin surface does not serve", async () => {
    const odd = await newAdmin("odd-type", []);
    expect((await readMe(odd.cookie)).accountType).toBe("tenant_admin");
    for (const accountType of ["print_operator", "ordinary"]) {
      await env.DB.prepare("UPDATE identity_access SET account_type = ? WHERE user_id = ?")
        .bind(accountType, odd.userId)
        .run();
      await expectUnauthenticated(await me({ cookie: odd.cookie }), accountType);
    }
  });

  it("answers 401 the moment the identity is deactivated after sign-in, and 200 again when it is restored", async () => {
    const admin = await newAdmin("deactivated", [shopA]);
    expect((await readMe(admin.cookie)).memberships.map((m) => m.tenantId)).toEqual([shopA.tenantId]);

    for (const status of ["suspended", "revoked"]) {
      await setIdentityStatus(admin.userId, status);
      await expectUnauthenticated(await me({ cookie: admin.cookie }), status);
      await expectOpaque404(await shop(admin.cookie, shopA.tenantId), `shop while ${status}`);
    }

    await setIdentityStatus(admin.userId, "active");
    expect((await readMe(admin.cookie)).user.id).toBe(admin.userId);
  });

  it("refuses X-Shop-Id with 400 before the session is read (D70), signed in or not", async () => {
    for (const [label, cookie] of [
      ["tenant admin", shopA.adminCookie],
      ["platform", world.platformCookie],
      ["no session", undefined],
    ] as const) {
      const response = await me({ cookie, shopId: shopA.tenantId });
      expect(await expectJson(response, 400, label), label).toEqual({
        error: { code: "invalid_request", message: "Request is not valid" },
      });
    }
  });

  it("answers the opaque 404 to any other method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(
        await call(world, method, `${ADMIN}/v1/me`, { body: {}, cookie: shopA.adminCookie }),
        method,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/admin/shop refuses", () => {
  it("answers the opaque 404 without a session, without a shop, with a malformed shop", async () => {
    await expectOpaque404(await shop(undefined, shopA.tenantId), "no session");
    await expectOpaque404(await shop(shopA.adminCookie, undefined), "no X-Shop-Id");
    for (const bad of ["", "WA-A", "wa-a/../wa-b", "wa a", "x".repeat(65)]) {
      await expectOpaque404(await shop(shopA.adminCookie, bad), `malformed ${JSON.stringify(bad)}`);
    }
  });

  it("answers the opaque 404 for a foreign shop and for one that does not exist", async () => {
    await expectOpaque404(await shop(shopA.adminCookie, shopB.tenantId), "foreign shop");
    await expectOpaque404(await shop(shopA.adminCookie, "wa-nowhere"), "unknown shop");
  });

  it("answers the opaque 404 to a platform user without an acting-as grant", async () => {
    await expectOpaque404(await shop(world.platformCookie, shopA.tenantId), "platform, no grant");
  });

  it("answers the opaque 404 to any other method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(
        await call(world, method, `${ADMIN}/v1/admin/shop`, {
          body: {},
          cookie: shopA.adminCookie,
          shopId: shopA.tenantId,
        }),
        method,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/me for a shop's admin", () => {
  it("answers the contract's shape with the live memberships, sorted by shop", async () => {
    const admin = await newAdmin("two-shops", [shopB, shopA]);
    const response = await me({ cookie: admin.cookie });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await expectJson<MeBody>(response, 200, "me");

    expect(Object.keys(body)).toEqual(["user", "accountType", "platform", "memberships", "actingAs"]);
    const user = await env.DB.prepare('SELECT "name" FROM "user" WHERE "id" = ?')
      .bind(admin.userId)
      .first<{ name: string }>();
    expect(body).toEqual({
      user: { id: admin.userId, email: admin.email, name: user?.name },
      accountType: "tenant_admin",
      platform: false,
      memberships: [shopA, shopB].map((tenant) => ({
        tenantId: tenant.tenantId,
        shopName: tenant.shopName,
        status: "active",
        published: expect.any(Boolean),
        role: "admin",
      })),
      actingAs: [],
    });
    for (const membership of body.memberships) {
      const row = await env.DB.prepare("SELECT published FROM tenants WHERE tenant_id = ?")
        .bind(membership.tenantId)
        .first<{ published: number }>();
      expect(membership.published).toBe(row?.published === 1);
    }
  });

  it("drops a membership revoked after sign-in from the next answer, and the shop refuses", async () => {
    const admin = await newAdmin("revoked-membership", [shopA, shopB]);
    expect((await readMe(admin.cookie)).memberships.map((m) => m.tenantId)).toEqual([
      shopA.tenantId,
      shopB.tenantId,
    ]);
    await expectJson(await shop(admin.cookie, shopB.tenantId), 200, "shop B before");

    for (const status of ["suspended", "revoked"]) {
      await env.DB.prepare(
        "UPDATE tenant_memberships SET status = ? WHERE user_id = ? AND tenant_id = ?",
      )
        .bind(status, admin.userId, shopB.tenantId)
        .run();
      expect(
        (await readMe(admin.cookie)).memberships.map((m) => m.tenantId),
        status,
      ).toEqual([shopA.tenantId]);
      await expectOpaque404(await shop(admin.cookie, shopB.tenantId), `shop B ${status}`);
    }
    await expectJson(await shop(admin.cookie, shopA.tenantId), 200, "shop A still");
  });

  it("lists only admin memberships (a customer-role row admits nothing)", async () => {
    const admin = await newAdmin("customer-row", [shopA]);
    await env.DB.prepare(
      `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', 'active', ?, ?)`,
    )
      .bind(crypto.randomUUID(), shopB.tenantId, admin.userId, Date.now(), Date.now())
      .run();
    expect((await readMe(admin.cookie)).memberships.map((m) => m.tenantId)).toEqual([shopA.tenantId]);
  });

  it("lists a suspended or closed shop with its status, while the shop read refuses it as every admin route does", async () => {
    const admin = await newAdmin("inactive-shop", [shopD, shopE]);
    try {
      await setTenantStatus(shopD.tenantId, "suspended");
      await setTenantStatus(shopE.tenantId, "closed");
      expect((await readMe(admin.cookie)).memberships).toEqual([
        expect.objectContaining({ status: "suspended", tenantId: shopD.tenantId }),
        expect.objectContaining({ status: "closed", tenantId: shopE.tenantId }),
      ]);
      await expectOpaque404(await shop(admin.cookie, shopD.tenantId), "shop suspended");
      await expectOpaque404(await shop(admin.cookie, shopE.tenantId), "shop closed");
    } finally {
      await setTenantStatus(shopD.tenantId, "active");
    }
    await expectJson(await shop(admin.cookie, shopD.tenantId), 200, "active again");
  });

  it("answers an admin with no membership with empty lists (the client shows no shop)", async () => {
    const admin = await newAdmin("no-shop", []);
    expect(await readMe(admin.cookie)).toMatchObject({
      accountType: "tenant_admin",
      actingAs: [],
      memberships: [],
      platform: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/me for a platform user", () => {
  it("answers platform true, no memberships, and only the grants a request would act under", async () => {
    const now = Date.now();
    const past = (ms: number) => new Date(now - ms).toISOString();
    const future = (ms: number) => new Date(now + ms).toISOString();

    // Expired (A), revoked (B), on a suspended shop (D): none listed.
    await insertGrant(shopA.tenantId, past(2 * 3_600_000), past(3_600_000));
    await insertGrant(shopB.tenantId, past(60_000), future(3_000_000), past(30_000));
    await insertGrant(shopD.tenantId, past(60_000), future(3_000_000));
    await setTenantStatus(shopD.tenantId, "suspended");
    try {
      // Two live grants on C: the later expiry is the one listed, once.
      await insertGrant(shopC.tenantId, past(60_000), future(60_000));
      const expiresAt = await openGrant(shopC.tenantId);

      const body = await readMe(world.platformCookie);
      expect(body).toEqual({
        user: { id: world.platformUserId, email: "platform@slice.test", name: "Slice Platform" },
        accountType: "platform_admin",
        platform: true,
        memberships: [],
        actingAs: [{ tenantId: shopC.tenantId, shopName: shopC.shopName, expiresAt }],
      });

      // The banner's grant admits the shop read; ending it ends both.
      await expectJson(await shop(world.platformCookie, shopC.tenantId), 200, "acting-as shop read");
      await closeGrants(shopC.tenantId);
      expect((await readMe(world.platformCookie)).actingAs).toEqual([]);
      await expectOpaque404(await shop(world.platformCookie, shopC.tenantId), "after the grant ended");
    } finally {
      await setTenantStatus(shopD.tenantId, "active");
    }
    // Reactivated, the shop's live grant is usable again — and listed again,
    // as findActiveActingAsGrant would honour it. Ended here for the next test.
    expect((await readMe(world.platformCookie)).actingAs.map((g) => g.tenantId)).toEqual([shopD.tenantId]);
    await closeGrants(shopD.tenantId);
    expect((await readMe(world.platformCookie)).actingAs).toEqual([]);
  });

  it("drops a grant the moment it expires", async () => {
    const now = Date.now();
    await insertGrant(shopB.tenantId, new Date(now - 60_000).toISOString(), new Date(now + 1_500).toISOString());
    expect((await readMe(world.platformCookie)).actingAs.map((g) => g.tenantId)).toEqual([shopB.tenantId]);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect((await readMe(world.platformCookie)).actingAs).toEqual([]);
  });

  it("answers 401 for a platform user whose identity is deactivated, grant or not", async () => {
    // The provisioning route makes no platform admin (provision-users.ts), so
    // a second operator is a tenant admin promoted by SQL.
    const operator = await newAdmin("second-operator", []);
    await env.DB.prepare("UPDATE identity_access SET account_type = 'platform_admin' WHERE user_id = ?")
      .bind(operator.userId)
      .run();
    expect(await readMe(operator.cookie)).toMatchObject({ accountType: "platform_admin", platform: true });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        operator.userId,
        shopA.tenantId,
        new Date(now - 60_000).toISOString(),
        new Date(now + 3_000_000).toISOString(),
      )
      .run();
    expect((await readMe(operator.cookie)).actingAs.map((g) => g.tenantId)).toEqual([shopA.tenantId]);
    await setIdentityStatus(operator.userId, "suspended");
    await expectUnauthenticated(await me({ cookie: operator.cookie }), "suspended operator");
    await expectOpaque404(await shop(operator.cookie, shopA.tenantId), "suspended operator's grant");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/admin/shop", () => {
  it("answers the contract's shape from the tenant row, uncached", async () => {
    const response = await shop(shopA.adminCookie, shopA.tenantId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await expectJson<ShopBody>(response, 200, "shop");

    const row = await env.DB.prepare(
      `SELECT shop_name, support_email, status, published, default_locale, default_currency, vat_rate_bp
       FROM tenants WHERE tenant_id = ?`,
    )
      .bind(shopA.tenantId)
      .first<{
        default_currency: string;
        default_locale: string;
        published: number;
        shop_name: string;
        status: string;
        support_email: string | null;
        vat_rate_bp: number;
      }>();
    expect(Object.keys(body)).toEqual(["shop"]);
    expect(Object.keys(body.shop)).toEqual([
      "tenantId",
      "shopName",
      "supportEmail",
      "status",
      "published",
      "defaultLocale",
      "currency",
      "vatRateBp",
      "features",
    ]);
    expect(body.shop).toMatchObject({
      tenantId: shopA.tenantId,
      shopName: shopA.shopName,
      supportEmail: row?.support_email,
      status: "active",
      published: row?.published === 1,
      defaultLocale: row?.default_locale,
      currency: row?.default_currency,
      vatRateBp: row?.vat_rate_bp,
    });
  });

  it("carries no commission, Connect or cost fact (the one-number rule)", async () => {
    const text = await (await shop(shopA.adminCookie, shopA.tenantId)).text();
    for (const word of ["commission", "stripe", "connect", "acct_", "catalogVersion", "cost", "printer"]) {
      expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it("answers every key the admin's menu reads, each a boolean; not-ported and deleted keys are false", async () => {
    const { features } = (await expectJson<ShopBody>(await shop(shopA.adminCookie, shopA.tenantId), 200, "shop")).shop;
    for (const key of [...FEATURE_KEYS, ...NOT_PORTED_FEATURE_KEYS, ...DELETED_FEATURE_KEYS, "pickup"]) {
      expect(typeof features[key], key).toBe("boolean");
    }
    expect(Object.values(features).every((value) => typeof value === "boolean")).toBe(true);
    // Defaults: pod is opt-in (off); the default-on add-ons are not ported (off); pickup is core.
    expect(features).toMatchObject({
      abandonedCheckout: false,
      affiliate: false,
      b2b: false,
      contentStudio: false,
      dining: false,
      discountCodes: false,
      marketingMaterials: false,
      pickup: true,
      pod: false,
      productReviews: false,
    });
  });

  it("follows the platform's switches for a ported key, and never lights a not-ported one", async () => {
    await expectJson(
      await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/features`, {
        body: { features: { discountCodes: true, pod: true, productReviews: true } },
      }),
      200,
      "enable",
    );
    const on = (await expectJson<ShopBody>(await shop(shopB.adminCookie, shopB.tenantId), 200, "on")).shop.features;
    expect(on).toMatchObject({ discountCodes: false, pod: true, productReviews: false });

    await expectJson(
      await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/features`, {
        body: { features: { pod: false } },
      }),
      200,
      "disable",
    );
    const off = (await expectJson<ShopBody>(await shop(shopB.adminCookie, shopB.tenantId), 200, "off")).shop.features;
    expect(off.pod).toBe(false);
    // Another shop's switch is not this shop's.
    expect(
      (await expectJson<ShopBody>(await shop(shopA.adminCookie, shopA.tenantId), 200, "A")).shop.features.pod,
    ).toBe(false);
  });

  it("is a pure function of the feature views (adminFeatures)", () => {
    const features = adminFeatures([
      { enabled: true, key: "pod" },
      { enabled: true, key: "discountCodes" },
      { enabled: true, key: "affiliate" },
    ]);
    expect(features.pod).toBe(true);
    expect(features.discountCodes).toBe(false);
    expect(features.affiliate).toBe(false);
    expect(features.pickup).toBe(true);
  });
});
