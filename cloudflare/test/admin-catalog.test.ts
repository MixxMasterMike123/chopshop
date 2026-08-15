import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const HOST_A = "https://admin-a.adminshop.test";
const HOST_B = "https://admin-b.adminshop.test";
const TENANT_A = "tenant-admin-a";
const TENANT_B = "tenant-admin-b";
const NOW = 1_787_200_000_000;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

interface AdminProductBody {
  product: {
    currency: string;
    description: string | null;
    name: string;
    priceMinor: number;
    productId: string;
    sku: string;
    status: string;
  };
}

let adminA: SignedUpUser;
let adminB: SignedUpUser;
let ordinary: SignedUpUser;
let revoked: SignedUpUser;

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

async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency,
        created_at, updated_at
      ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

async function seedMembership(
  userId: string,
  tenantId: string,
  role: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_memberships (
      membership_id, tenant_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(`membership-${tenantId}-${userId}`, tenantId, userId, role, NOW, NOW)
    .run();
}

function adminRequest(
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

async function createProduct(
  host: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    adminRequest(`${host}/v1/admin/products`, "POST", { body, cookie }),
  );
}

async function listPublicProducts(host: string): Promise<string[]> {
  const response = await exports.default.fetch(`${host}/v1/products`);
  const body = await response.json<{ products: { productId: string }[] }>();
  return body.products.map((product) => product.productId);
}

async function publicationRow(productId: string): Promise<{
  projection_version: number;
  public_price_minor: number;
  published: number;
} | null> {
  return env.DB.prepare(
    `SELECT published, projection_version, public_price_minor
     FROM product_publications
     WHERE product_id = ?`,
  )
    .bind(productId)
    .first();
}

async function auditRows(productId: string): Promise<
  { action: string; actor_user_id: string | null; tenant_id: string | null }[]
> {
  const result = await env.DB.prepare(
    `SELECT action, actor_user_id, tenant_id
     FROM audit_events
     WHERE resource_type = 'product'
       AND resource_id = ?
     ORDER BY created_at ASC, event_id ASC`,
  )
    .bind(productId)
    .all<{
      action: string;
      actor_user_id: string | null;
      tenant_id: string | null;
    }>();

  return result.results;
}

async function countProducts(tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM products WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "admin-a.adminshop.test");
  await seedTenant(TENANT_B, "admin-b.adminshop.test");

  adminA = await signUp("admin-a@adminshop.test");
  adminB = await signUp("admin-b@adminshop.test");
  ordinary = await signUp("ordinary@adminshop.test");
  revoked = await signUp("revoked-admin@adminshop.test");

  await seedAccess(adminA.userId, "tenant_admin");
  await seedAccess(adminB.userId, "tenant_admin");
  await seedAccess(ordinary.userId, "ordinary");
  await seedAccess(revoked.userId, "tenant_admin");

  await seedMembership(adminA.userId, TENANT_A, "admin");
  await seedMembership(adminB.userId, TENANT_B, "admin");
  await seedMembership(ordinary.userId, TENANT_A, "customer");
  await seedMembership(revoked.userId, TENANT_A, "admin");
});

describe("tenant-admin catalogue lifecycle", () => {
  it("creates, publishes, reprices and unpublishes a product", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      description: "Soft cotton",
      name: "Lifecycle Tee",
      priceMinor: 19_900,
      sku: "SKU-LIFECYCLE",
    });
    const createdBody = await created.json<AdminProductBody>();

    expect(created.status).toBe(201);
    expect(createdBody.product).toEqual({
      currency: "SEK",
      description: "Soft cotton",
      name: "Lifecycle Tee",
      priceMinor: 19_900,
      productId: expect.any(String),
      sku: "SKU-LIFECYCLE",
      status: "draft",
    });

    const productId = createdBody.product.productId;
    expect(await listPublicProducts(HOST_A)).not.toContain(productId);

    const activated = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${productId}`, "PATCH", {
        body: { status: "active" },
        cookie: adminA.cookie,
      }),
    );
    expect(activated.status).toBe(200);

    const published = await exports.default.fetch(
      adminRequest(
        `${HOST_A}/v1/admin/products/${productId}/publish`,
        "POST",
        { cookie: adminA.cookie },
      ),
    );
    expect(published.status).toBe(200);
    expect(await listPublicProducts(HOST_A)).toContain(productId);

    const beforeRepricing = await publicationRow(productId);
    const repriced = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${productId}`, "PATCH", {
        body: { priceMinor: 24_900 },
        cookie: adminA.cookie,
      }),
    );
    expect(repriced.status).toBe(200);

    const afterRepricing = await publicationRow(productId);
    expect(afterRepricing?.public_price_minor).toBe(24_900);
    expect(afterRepricing?.projection_version).toBe(
      (beforeRepricing?.projection_version ?? 0) + 1,
    );

    const publicDetail = await exports.default.fetch(
      `${HOST_A}/v1/products/${productId}`,
    );
    await expect(publicDetail.json()).resolves.toMatchObject({
      product: { priceMinor: 24_900 },
    });

    const unpublished = await exports.default.fetch(
      adminRequest(
        `${HOST_A}/v1/admin/products/${productId}/unpublish`,
        "POST",
        { cookie: adminA.cookie },
      ),
    );
    expect(unpublished.status).toBe(200);
    expect(await listPublicProducts(HOST_A)).not.toContain(productId);

    const repeated = await exports.default.fetch(
      adminRequest(
        `${HOST_A}/v1/admin/products/${productId}/unpublish`,
        "POST",
        { cookie: adminA.cookie },
      ),
    );
    expect(repeated.status).toBe(200);

    expect((await auditRows(productId)).map((row) => row.action)).toEqual([
      "product.create",
      "product.update",
      "product.publish",
      "product.update",
      "product.unpublish",
      "product.unpublish",
    ]);
    for (const row of await auditRows(productId)) {
      expect(row.actor_user_id).toBe(adminA.userId);
      expect(row.tenant_id).toBe(TENANT_A);
    }
  });

  it("archiving a published product unpublishes its projection", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Archive Me",
      priceMinor: 9_900,
      sku: "SKU-ARCHIVE",
    });
    const { product } = await created.json<AdminProductBody>();

    await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { status: "active" },
        cookie: adminA.cookie,
      }),
    );
    await exports.default.fetch(
      adminRequest(
        `${HOST_A}/v1/admin/products/${product.productId}/publish`,
        "POST",
        { cookie: adminA.cookie },
      ),
    );
    expect(await listPublicProducts(HOST_A)).toContain(product.productId);

    const archived = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { status: "archived" },
        cookie: adminA.cookie,
      }),
    );

    expect(archived.status).toBe(200);
    expect(await publicationRow(product.productId)).toMatchObject({
      published: 0,
    });
    expect(await listPublicProducts(HOST_A)).not.toContain(product.productId);
  });

  it("refuses to publish a draft product", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Still Draft",
      priceMinor: 4_900,
      sku: "SKU-STILL-DRAFT",
    });
    const { product } = await created.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(
        `${HOST_A}/v1/admin/products/${product.productId}/publish`,
        "POST",
        { cookie: adminA.cookie },
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    expect(await publicationRow(product.productId)).toBeNull();
    expect((await auditRows(product.productId)).map((row) => row.action)).toEqual(
      ["product.create"],
    );
  });
});

describe("tenant-admin catalogue authorization", () => {
  it("hides the surface from anonymous callers", async () => {
    const before = await countProducts(TENANT_A);
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Anonymous",
          priceMinor: 1_000,
          sku: "SKU-ANON",
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it("hides the surface from an ordinary signed-in user", async () => {
    const before = await countProducts(TENANT_A);
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Ordinary",
          priceMinor: 1_000,
          sku: "SKU-ORDINARY",
        },
        cookie: ordinary.cookie,
      }),
    );

    expect(response.status).toBe(404);
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it("hides tenant A's surface from tenant B's admin", async () => {
    const before = await countProducts(TENANT_A);
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Cross Tenant",
          priceMinor: 1_000,
          sku: "SKU-CROSS-TENANT",
        },
        cookie: adminB.cookie,
      }),
    );

    expect(response.status).toBe(404);
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it("refuses tenant B's admin mutating a tenant A product by id", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Tenant A Only",
      priceMinor: 5_000,
      sku: "SKU-TENANT-A-ONLY",
    });
    const { product } = await created.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_B}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { name: "Stolen" },
        cookie: adminB.cookie,
      }),
    );

    expect(response.status).toBe(404);
    await expect(
      env.DB.prepare("SELECT name FROM products WHERE product_id = ?")
        .bind(product.productId)
        .first<{ name: string }>(),
    ).resolves.toEqual({ name: "Tenant A Only" });
  });

  it("hides the surface after the session is revoked", async () => {
    const before = await countProducts(TENANT_A);
    await env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?')
      .bind(revoked.userId)
      .run();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: "Revoked",
          priceMinor: 1_000,
          sku: "SKU-REVOKED",
        },
        cookie: revoked.cookie,
      }),
    );

    expect(response.status).toBe(404);
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it.each([
    ["missing", null],
    ["cross-site", "https://evil.test"],
  ])("rejects a %s Origin even with a valid admin session", async (
    label,
    origin,
  ) => {
    const before = await countProducts(TENANT_A);
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: {
          currency: "SEK",
          name: `Csrf ${label}`,
          priceMinor: 1_000,
          sku: `SKU-CSRF-${label}`,
        },
        cookie: adminA.cookie,
        origin,
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it("does not expose the collection through another method", async () => {
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "GET", {
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ["https://admin-a.adminshop.test/v1/admin/products/"],
    ["https://admin-a.adminshop.test/v1/admin/products/abc/archive"],
    ["https://admin-a.adminshop.test/v1/admin/products/abc/publish/extra"],
  ])("rejects malformed admin path %s", async (target) => {
    const response = await exports.default.fetch(
      adminRequest(target, "POST", { cookie: adminA.cookie }),
    );

    expect(response.status).toBe(404);
  });
});

describe("tenant-admin catalogue validation", () => {
  it.each([
    [
      "unknown key",
      {
        currency: "SEK",
        isPod: true,
        name: "Bad",
        priceMinor: 1_000,
        sku: "SKU-BAD-1",
      },
    ],
    [
      "string price",
      { currency: "SEK", name: "Bad", priceMinor: "1000", sku: "SKU-BAD-2" },
    ],
    [
      "negative price",
      { currency: "SEK", name: "Bad", priceMinor: -1, sku: "SKU-BAD-3" },
    ],
    [
      "long currency",
      { currency: "SEKK", name: "Bad", priceMinor: 1_000, sku: "SKU-BAD-4" },
    ],
    [
      "lowercase currency",
      { currency: "sek", name: "Bad", priceMinor: 1_000, sku: "SKU-BAD-5" },
    ],
    [
      "empty sku",
      { currency: "SEK", name: "Bad", priceMinor: 1_000, sku: "" },
    ],
    [
      "long name",
      {
        currency: "SEK",
        name: "n".repeat(201),
        priceMinor: 1_000,
        sku: "SKU-BAD-6",
      },
    ],
    [
      "fractional price",
      { currency: "SEK", name: "Bad", priceMinor: 10.5, sku: "SKU-BAD-7" },
    ],
    ["missing name", { currency: "SEK", priceMinor: 1_000, sku: "SKU-BAD-8" }],
  ])("rejects create with %s", async (_label, body) => {
    const before = await countProducts(TENANT_A);
    const response = await createProduct(HOST_A, adminA.cookie, body);
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(responseBody)).not.toContain("SKU-BAD");
    await expect(countProducts(TENANT_A)).resolves.toBe(before);
  });

  it("rejects a malformed JSON body", async () => {
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products`, "POST", {
        body: "{not json",
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects an empty PATCH body", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Patch Target",
      priceMinor: 3_000,
      sku: "SKU-PATCH-EMPTY",
    });
    const { product } = await created.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: {},
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects a PATCH to an unsupported status", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Patch Status",
      priceMinor: 3_000,
      sku: "SKU-PATCH-STATUS",
    });
    const { product } = await created.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { status: "published" },
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a PATCH that tries to change currency", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Patch Currency",
      priceMinor: 3_000,
      sku: "SKU-PATCH-CURRENCY",
    });
    const { product } = await created.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { currency: "EUR" },
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 for a PATCH of an unknown product id", async () => {
    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/does-not-exist`, "PATCH", {
        body: { name: "Ghost" },
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("tenant-admin catalogue sku uniqueness", () => {
  it("rejects a duplicate sku inside the tenant but allows it in another", async () => {
    const first = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Unique One",
      priceMinor: 1_000,
      sku: "SKU-SHARED",
    });
    expect(first.status).toBe(201);

    const duplicate = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Unique Two",
      priceMinor: 1_000,
      sku: "SKU-SHARED",
    });
    const duplicateBody = await duplicate.json();

    expect(duplicate.status).toBe(409);
    expect(duplicateBody).toMatchObject({ error: { code: "conflict" } });
    expect(JSON.stringify(duplicateBody)).not.toContain("UNIQUE");
    expect(JSON.stringify(duplicateBody)).not.toContain("SKU-SHARED");

    const otherTenant = await createProduct(HOST_B, adminB.cookie, {
      currency: "SEK",
      name: "Other Tenant",
      priceMinor: 1_000,
      sku: "SKU-SHARED",
    });
    expect(otherTenant.status).toBe(201);
  });

  it("rejects a PATCH that collides with an existing sku", async () => {
    const target = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Rename Target",
      priceMinor: 1_000,
      sku: "SKU-RENAME-TARGET",
    });
    const { product } = await target.json<AdminProductBody>();

    const response = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { sku: "SKU-SHARED" },
        cookie: adminA.cookie,
      }),
    );

    expect(response.status).toBe(409);
    await expect(
      env.DB.prepare("SELECT sku FROM products WHERE product_id = ?")
        .bind(product.productId)
        .first<{ sku: string }>(),
    ).resolves.toEqual({ sku: "SKU-RENAME-TARGET" });
  });
});

describe("tenant-admin catalogue audit trail", () => {
  it("appends immutable audit rows for each mutation", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Audited",
      priceMinor: 2_500,
      sku: "SKU-AUDITED",
    });
    const { product } = await created.json<AdminProductBody>();

    const rows = await auditRows(product.productId);
    expect(rows).toEqual([
      {
        action: "product.create",
        actor_user_id: adminA.userId,
        tenant_id: TENANT_A,
      },
    ]);

    await expect(
      env.DB.prepare(
        "UPDATE audit_events SET action = ? WHERE resource_id = ?",
      )
        .bind("product.tampered", product.productId)
        .run(),
    ).rejects.toThrow("audit events are append-only");
  });

  it("records only field names for an update, never values", async () => {
    const created = await createProduct(HOST_A, adminA.cookie, {
      currency: "SEK",
      name: "Metadata Check",
      priceMinor: 2_500,
      sku: "SKU-METADATA",
    });
    const { product } = await created.json<AdminProductBody>();

    await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/products/${product.productId}`, "PATCH", {
        body: { name: "Secret New Name", priceMinor: 7_700 },
        cookie: adminA.cookie,
      }),
    );

    const row = await env.DB.prepare(
      `SELECT metadata_json
       FROM audit_events
       WHERE resource_id = ?
         AND action = 'product.update'
       LIMIT 1`,
    )
      .bind(product.productId)
      .first<{ metadata_json: string | null }>();

    expect(row?.metadata_json).toBe(JSON.stringify({ fields: ["name", "priceMinor"] }));
    expect(row?.metadata_json).not.toContain("Secret New Name");
    expect(row?.metadata_json).not.toContain("7700");
  });
});
