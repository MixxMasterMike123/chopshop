import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";
import { authorizeTenantAdminRequest } from "../src/auth/request-authorization";
import { grantActingAs, revokeActingAs } from "../src/platform/acting-as";
import {
  ACTING_AS_TTL_MS,
  parseActingAsGrantInput,
} from "../src/platform/acting-as";

/**
 * PLAN §2.1: "Platform 'open shop admin' = server-minted, audited, time-boxed
 * acting-as session." The platform surface lives on one host, the admin surface
 * on another; neither hostname carries a tenant.
 */
const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const PLATFORM_HOST = "https://console.acting.test";
const ADMIN_HOST = "https://admin.acting.test";
const SHOP_A = "tenant-acting-a";
const SHOP_B = "tenant-acting-b";
const SHOP_SUSPENDED = "tenant-acting-suspended";
const NOW = 1_787_600_000_000;
const PASSWORD = "test-password-long-enough";

interface SignedUpUser {
  cookie: string;
  userId: string;
}

let operator: SignedUpUser;
let colleague: SignedUpUser;
let demoted: SignedUpUser;
let shopAdmin: SignedUpUser;
let ordinary: SignedUpUser;
let productCounter = 0;

async function signUp(email: string): Promise<SignedUpUser> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  expect(response.status).toBe(200);

  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const setCookie = signedIn.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("sign-in returned no session cookie");
  }

  return { cookie: setCookie.split(";", 1)[0] as string, userId: body.user.id };
}

async function seedAccess(userId: string, accountType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(userId, accountType, NOW, NOW)
    .run();
}

async function seedTenant(tenantId: string, status = "active"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, ?, ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, status, `Shop ${tenantId}`, NOW, NOW)
    .run();
}

function request(
  target: string,
  method: string,
  options: {
    body?: string;
    cookie?: string;
    origin?: string | null;
    shopId?: string;
  } = {},
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
  if (options.shopId !== undefined) {
    headers.set("x-shop-id", options.shopId);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new Request(target, { body: options.body, headers, method });
}

function actingAs(
  shopId: string,
  method: "DELETE" | "GET" | "POST",
  cookie: string,
  options: { body?: string; origin?: string | null } = {},
): Promise<Response> {
  return exports.default.fetch(
    request(
      `${PLATFORM_HOST}/v1/platform/tenants/${shopId}/acting-as`,
      method,
      { ...options, cookie },
    ),
  );
}

function createProduct(cookie: string, shopId: string): Promise<Response> {
  productCounter += 1;
  return exports.default.fetch(
    request(`${ADMIN_HOST}/v1/admin/products`, "POST", {
      body: JSON.stringify({
        currency: "SEK",
        name: `Acting product ${productCounter}`,
        priceMinor: 1_000,
        sku: `SKU-ACTING-${productCounter}`,
      }),
      cookie,
      shopId,
    }),
  );
}

async function grantRows(
  userId: string,
  shopId: string,
): Promise<
  {
    created_at: string;
    expires_at: string;
    id: string;
    reason: string | null;
    revoked_at: string | null;
  }[]
> {
  const result = await env.DB.prepare(
    `SELECT id, created_at, expires_at, revoked_at, reason
     FROM acting_as_grants
     WHERE platform_user_id = ? AND tenant_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(userId, shopId)
    .all<{
      created_at: string;
      expires_at: string;
      id: string;
      reason: string | null;
      revoked_at: string | null;
    }>();

  return result.results;
}

async function auditRows(
  shopId: string,
  action: string,
): Promise<
  {
    actor_user_id: string | null;
    metadata_json: string | null;
    reason: string | null;
    resource_id: string | null;
    resource_type: string;
  }[]
> {
  const result = await env.DB.prepare(
    `SELECT actor_user_id, resource_type, resource_id, reason, metadata_json
     FROM audit_events
     WHERE tenant_id = ? AND action = ?
     ORDER BY created_at ASC, event_id ASC`,
  )
    .bind(shopId, action)
    .all<{
      actor_user_id: string | null;
      metadata_json: string | null;
      reason: string | null;
      resource_id: string | null;
      resource_type: string;
    }>();

  return result.results;
}

beforeAll(async () => {
  await seedTenant(SHOP_A);
  await seedTenant(SHOP_B);
  await seedTenant(SHOP_SUSPENDED, "suspended");

  operator = await signUp("operator@acting.test");
  colleague = await signUp("colleague@acting.test");
  demoted = await signUp("demoted@acting.test");
  shopAdmin = await signUp("shop-admin@acting.test");
  ordinary = await signUp("ordinary@acting.test");

  await seedAccess(operator.userId, "platform_admin");
  await seedAccess(colleague.userId, "platform_admin");
  await seedAccess(demoted.userId, "platform_admin");
  await seedAccess(shopAdmin.userId, "tenant_admin");
  await seedAccess(ordinary.userId, "ordinary");
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES ('membership-acting-a', ?, ?, 'admin', 'active', ?, ?)`,
  )
    .bind(SHOP_A, shopAdmin.userId, NOW, NOW)
    .run();
});

describe("minting a grant", () => {
  it.each([
    ["a tenant admin", () => shopAdmin],
    ["an ordinary user", () => ordinary],
  ])("refuses %s with the opaque 404", async (_label, who) => {
    const response = await actingAs(SHOP_A, "POST", who().cookie);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    await expect(grantRows(who().userId, SHOP_A)).resolves.toEqual([]);
  });

  it("refuses an anonymous caller", async () => {
    const response = await exports.default.fetch(
      request(`${PLATFORM_HOST}/v1/platform/tenants/${SHOP_A}/acting-as`, "POST"),
    );
    expect(response.status).toBe(404);
  });

  it.each([
    ["missing", null],
    ["cross-site", "https://evil.test"],
  ])("refuses a %s Origin even for a platform admin", async (_label, origin) => {
    const response = await actingAs(SHOP_B, "POST", colleague.cookie, {
      origin,
    });

    expect(response.status).toBe(404);
    await expect(grantRows(colleague.userId, SHOP_B)).resolves.toEqual([]);
  });

  it("mints a 60-minute grant for the platform user and audits it", async () => {
    const before = Date.now();
    const response = await actingAs(SHOP_A, "POST", operator.cookie, {
      body: JSON.stringify({ reason: "Support ticket 4711" }),
    });
    const after = Date.now();

    expect(response.status).toBe(201);
    const body = await response.json<{ expiresAt: string; tenantId: string }>();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "tenantId"]);
    expect(body.tenantId).toBe(SHOP_A);
    // ISO-8601 UTC, server-written (PLAN §2.8).
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + ACTING_AS_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + ACTING_AS_TTL_MS);
    expect(ACTING_AS_TTL_MS).toBe(60 * 60 * 1_000);

    const rows = await grantRows(operator.userId, SHOP_A);
    expect(rows).toHaveLength(1);
    const [grant] = rows;
    expect(grant?.expires_at).toBe(body.expiresAt);
    expect(grant?.revoked_at).toBeNull();
    expect(grant?.reason).toBe("Support ticket 4711");

    const audits = await auditRows(SHOP_A, "acting_as.granted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: operator.userId,
      reason: "Support ticket 4711",
      resource_id: SHOP_A,
      resource_type: "tenant",
    });
    expect(JSON.parse(audits[0]?.metadata_json ?? "null")).toEqual({
      expiresAt: body.expiresAt,
      grantId: grant?.id,
    });
  });

  it("accepts an empty body and stores no reason", async () => {
    const response = await actingAs(SHOP_B, "POST", colleague.cookie);
    expect(response.status).toBe(201);

    const rows = await grantRows(colleague.userId, SHOP_B);
    expect(rows.at(-1)?.reason).toBeNull();
  });

  it.each([
    ["unparseable JSON", "{nope"],
    ["an unknown key", JSON.stringify({ reason: "x", shop: SHOP_B })],
    ["a blank reason", JSON.stringify({ reason: "   " })],
    ["a non-string reason", JSON.stringify({ reason: 42 })],
    ["an over-long reason", JSON.stringify({ reason: "r".repeat(501) })],
    ["an array", "[]"],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await actingAs(SHOP_A, "POST", demoted.cookie, { body });

    expect(response.status).toBe(400);
    await expect(grantRows(demoted.userId, SHOP_A)).resolves.toEqual([]);
  });

  it.each([
    ["a suspended shop", SHOP_SUSPENDED],
    ["an unknown shop", "tenant-acting-nowhere"],
  ])("refuses %s with the same 404", async (_label, shopId) => {
    const response = await actingAs(shopId, "POST", operator.cookie);

    expect(response.status).toBe(404);
    await expect(grantRows(operator.userId, shopId)).resolves.toEqual([]);
  });

  it.each([
    ["GET", "/v1/platform/tenants/tenant-acting-a/acting-as"],
    ["POST", "/v1/platform/tenants/Tenant-Acting-A/acting-as"],
    ["POST", "/v1/platform/tenants/tenant%2Dacting%2Da/acting-as/x"],
    ["POST", "/v1/platform/tenants/%2574enant-acting-a/acting-as"],
  ])("answers the opaque 404 for %s %s", async (method, path) => {
    const response = await exports.default.fetch(
      request(`${PLATFORM_HOST}${path}`, method, { cookie: operator.cookie }),
    );
    expect(response.status).toBe(404);
  });

  it("parses the optional body strictly", () => {
    expect(parseActingAsGrantInput("")).toEqual({ reason: null });
    expect(parseActingAsGrantInput("{}")).toEqual({ reason: null });
    expect(parseActingAsGrantInput('{"reason":"  ok  "}')).toEqual({
      reason: "ok",
    });
    expect(parseActingAsGrantInput("null")).toBeNull();
  });
});

describe("using a grant on the admin surface", () => {
  it("opens exactly the granted shop, and audits every mutation with the grant", async () => {
    const [grant] = await grantRows(operator.userId, SHOP_A);
    if (grant === undefined) {
      throw new Error("expected the operator's grant from the minting suite");
    }

    const created = await createProduct(operator.cookie, SHOP_A);
    expect(created.status).toBe(201);
    const { product } = await created.json<{ product: { productId: string } }>();

    const row = await env.DB.prepare(
      "SELECT tenant_id FROM products WHERE product_id = ?",
    )
      .bind(product.productId)
      .first<{ tenant_id: string }>();
    expect(row).toEqual({ tenant_id: SHOP_A });

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json FROM audit_events
       WHERE action = 'product.create' AND resource_id = ?`,
    )
      .bind(product.productId)
      .first<{ actor_user_id: string; metadata_json: string }>();
    expect(audit?.actor_user_id).toBe(operator.userId);
    expect(JSON.parse(audit?.metadata_json ?? "null")).toEqual({
      actingAsGrantId: grant.id,
    });
  });

  it("carries actingAs on the principal the guard returns", async () => {
    const [grant] = await grantRows(operator.userId, SHOP_A);
    await expect(
      authorizeTenantAdminRequest(
        env,
        request(`${ADMIN_HOST}/v1/admin/products`, "GET", {
          cookie: operator.cookie,
          shopId: SHOP_A,
        }),
      ),
    ).resolves.toEqual({
      accountType: "tenant_admin",
      actingAs: { grantId: grant?.id },
      role: "admin",
      tenantId: SHOP_A,
      userId: operator.userId,
    });
  });

  it("does not open another shop", async () => {
    const response = await createProduct(operator.cookie, SHOP_B);
    expect(response.status).toBe(404);
  });

  it("does not open a shop for a platform user who holds no grant", async () => {
    const response = await createProduct(demoted.cookie, SHOP_A);
    expect(response.status).toBe(404);
  });

  it("leaves a member admin's audit metadata untouched", async () => {
    const created = await createProduct(shopAdmin.cookie, SHOP_A);
    expect(created.status).toBe(201);
    const { product } = await created.json<{ product: { productId: string } }>();

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, metadata_json FROM audit_events
       WHERE action = 'product.create' AND resource_id = ?`,
    )
      .bind(product.productId)
      .first<{ actor_user_id: string; metadata_json: string | null }>();
    expect(audit).toEqual({
      actor_user_id: shopAdmin.userId,
      metadata_json: null,
    });
  });

  it("refuses an EXPIRED grant", async () => {
    const past = Date.now() - 2 * ACTING_AS_TTL_MS;
    await env.DB.prepare(
      `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        demoted.userId,
        SHOP_B,
        new Date(past).toISOString(),
        new Date(past + ACTING_AS_TTL_MS).toISOString(),
      )
      .run();

    const response = await createProduct(demoted.cookie, SHOP_B);
    expect(response.status).toBe(404);
  });

  it("dies with the platform user's platform_admin record", async () => {
    const minted = await actingAs(SHOP_A, "POST", demoted.cookie);
    expect(minted.status).toBe(201);
    expect((await createProduct(demoted.cookie, SHOP_A)).status).toBe(201);

    await env.DB.prepare(
      "UPDATE identity_access SET status = 'suspended', updated_at = ? WHERE user_id = ?",
    )
      .bind(NOW + 1, demoted.userId)
      .run();

    expect((await createProduct(demoted.cookie, SHOP_A)).status).toBe(404);
  });

  it("dies when the shop is suspended", async () => {
    // Colleague holds a live grant on B from the minting suite.
    expect((await createProduct(colleague.cookie, SHOP_B)).status).toBe(201);

    await env.DB.prepare(
      "UPDATE tenants SET status = 'suspended', updated_at = ? WHERE tenant_id = ?",
    )
      .bind(NOW + 1, SHOP_B)
      .run();
    expect((await createProduct(colleague.cookie, SHOP_B)).status).toBe(404);

    await env.DB.prepare(
      "UPDATE tenants SET status = 'active', updated_at = ? WHERE tenant_id = ?",
    )
      .bind(NOW + 2, SHOP_B)
      .run();
    expect((await createProduct(colleague.cookie, SHOP_B)).status).toBe(201);
  });
});

describe("revoking a grant", () => {
  it("revokes only the caller's own grants, and audits the revocation", async () => {
    // Colleague opens shop A too; the operator's revoke must not touch it.
    expect((await actingAs(SHOP_A, "POST", colleague.cookie)).status).toBe(201);

    const revoked = await actingAs(SHOP_A, "DELETE", operator.cookie);
    expect(revoked.status).toBe(204);

    const operatorGrants = await grantRows(operator.userId, SHOP_A);
    expect(operatorGrants.every((grant) => grant.revoked_at !== null)).toBe(true);
    const colleagueGrants = await grantRows(colleague.userId, SHOP_A);
    expect(colleagueGrants.some((grant) => grant.revoked_at === null)).toBe(true);

    const audits = await auditRows(SHOP_A, "acting_as.revoked");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: operator.userId,
      resource_id: SHOP_A,
      resource_type: "tenant",
    });
    expect(JSON.parse(audits[0]?.metadata_json ?? "null")).toEqual({
      grantIds: operatorGrants.map((grant) => grant.id),
    });
  });

  it("closes the admin surface immediately", async () => {
    expect((await createProduct(operator.cookie, SHOP_A)).status).toBe(404);
    expect((await createProduct(colleague.cookie, SHOP_A)).status).toBe(201);
  });

  it("answers 404 when there is nothing live to revoke, and audits nothing", async () => {
    const response = await actingAs(SHOP_A, "DELETE", operator.cookie);
    expect(response.status).toBe(404);
    await expect(auditRows(SHOP_A, "acting_as.revoked")).resolves.toHaveLength(1);
  });

  it("refuses a revoke from a non-platform session", async () => {
    const response = await actingAs(SHOP_A, "DELETE", shopAdmin.cookie);
    expect(response.status).toBe(404);
    const colleagueGrants = await grantRows(colleague.userId, SHOP_A);
    expect(colleagueGrants.some((grant) => grant.revoked_at === null)).toBe(true);
  });

  it("can be re-opened with a fresh grant", async () => {
    expect((await actingAs(SHOP_A, "POST", operator.cookie)).status).toBe(201);
    expect((await createProduct(operator.cookie, SHOP_A)).status).toBe(201);
  });

  it("revokes EVERY live grant, however many were minted (Codex db66555)", async () => {
    // 51 more on top of the live one: a bounded SELECT-then-UPDATE would leave
    // the newest alive and still answer 204.
    for (let i = 0; i < 51; i += 1) {
      expect((await actingAs(SHOP_A, "POST", operator.cookie)).status).toBe(201);
    }
    const before = await grantRows(operator.userId, SHOP_A);
    expect(before.filter((grant) => grant.revoked_at === null).length).toBeGreaterThan(50);

    expect((await actingAs(SHOP_A, "DELETE", operator.cookie)).status).toBe(204);

    const after = await grantRows(operator.userId, SHOP_A);
    expect(after.every((grant) => grant.revoked_at !== null)).toBe(true);
    expect((await createProduct(operator.cookie, SHOP_A)).status).toBe(404);

    const audits = await auditRows(SHOP_A, "acting_as.revoked");
    const last = audits[audits.length - 1];
    const ids = (JSON.parse(last?.metadata_json ?? "{}") as { grantIds: string[] }).grantIds;
    expect(ids).toHaveLength(52);
    expect(new Set(ids)).toEqual(
      new Set(before.filter((grant) => grant.revoked_at === null).map((grant) => grant.id)),
    );
  });
});

describe("revoke audit correlation (Codex 7908e83)", () => {
  it("a second revoke in the SAME millisecond revokes nothing and audits nothing", async () => {
    const platform = { accountType: "platform_admin" as const, userId: operator.userId };
    const t = NOW + 5_000_000;
    expect((await grantActingAs(env.DB, platform, SHOP_B, { reason: null }, t - 1)).status).toBe("ok");
    const before = (await auditRows(SHOP_B, "acting_as.revoked")).length;

    const first = await revokeActingAs(env.DB, platform, SHOP_B, t);
    expect(first).toEqual({ revoked: 1, status: "ok" });
    const second = await revokeActingAs(env.DB, platform, SHOP_B, t);
    expect(second).toEqual({ status: "not_found" });

    expect((await auditRows(SHOP_B, "acting_as.revoked")).length).toBe(before + 1);
  });
});

describe("grant ledger integrity (schema)", () => {
  async function anyGrantId(): Promise<string> {
    const row = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE revoked_at IS NULL LIMIT 1",
    ).first<{ id: string }>();
    if (row === null) {
      throw new Error("expected a live grant");
    }
    return row.id;
  }

  it("refuses widening a grant's window", async () => {
    const id = await anyGrantId();
    await expect(
      env.DB.prepare(
        "UPDATE acting_as_grants SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses moving a grant to another shop", async () => {
    const id = await anyGrantId();
    await expect(
      env.DB.prepare("UPDATE acting_as_grants SET tenant_id = ? WHERE id = ?")
        .bind(SHOP_SUSPENDED, id)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses reviving a revoked grant", async () => {
    const row = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE revoked_at IS NOT NULL LIMIT 1",
    ).first<{ id: string }>();
    await expect(
      env.DB.prepare("UPDATE acting_as_grants SET revoked_at = NULL WHERE id = ?")
        .bind(row?.id)
        .run(),
    ).rejects.toThrow(/final/);
  });

  it("refuses deleting a grant", async () => {
    const id = await anyGrantId();
    await expect(
      env.DB.prepare("DELETE FROM acting_as_grants WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses a timestamp that is not the server's ISO shape", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO acting_as_grants (id, platform_user_id, tenant_id, created_at, expires_at)
         VALUES (?, ?, ?, '2026-09-26 10:00:00', '2026-09-26 11:00:00')`,
      )
        .bind(crypto.randomUUID(), operator.userId, SHOP_A)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
