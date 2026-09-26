import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/auth/create-auth";

const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const HOST_A = "https://admin-a.dcadmin.test";
const HOST_B = "https://admin-b.dcadmin.test";
const TENANT_A = "tenant-dcadmin-a";
const TENANT_B = "tenant-dcadmin-b";
const NOW = 1_787_200_000_000;

interface SignedUpUser {
  cookie: string;
  userId: string;
}

interface DiscountCodeBody {
  discountCode: {
    active: boolean;
    code: string;
    discountCodeId: string;
    endsAt: number | null;
    maxUses: number | null;
    minSpendMinor: number | null;
    percentBp: number | null;
    productIds: string[] | null;
    scope: string;
    startsAt: number | null;
    type: string;
    usedCount: number;
    valueMinor: number | null;
  };
}

let adminA: SignedUpUser;
let adminB: SignedUpUser;
let ordinary: SignedUpUser;

// One password for every fixture identity: sign-up and the sign-in that
// follows it must agree, so the value lives in one place.
const FIXTURE_PASSWORD = "test-password-long-enough";

async function signUp(email: string): Promise<SignedUpUser> {
  // Better Auth caps /sign-up at 3 requests per 10s in a shared bucket when no
  // client IP is forwarded; drain the ledger between fixtures rather than sleep.
  await env.DB.prepare('DELETE FROM "rateLimit"').run();

  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: email,
        password: FIXTURE_PASSWORD,
      }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
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
  if (setCookie === null) {
    throw new Error("Better Auth sign-in did not return a session cookie");
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

async function createCode(
  host: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    adminRequest(`${host}/v1/admin/discount-codes`, "POST", { body, cookie }),
  );
}

async function patchCode(
  host: string,
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    adminRequest(`${host}/v1/admin/discount-codes/${id}`, "PATCH", {
      body,
      cookie,
    }),
  );
}

async function getCode(
  host: string,
  cookie: string | undefined,
  id: string,
): Promise<Response> {
  return exports.default.fetch(
    adminRequest(`${host}/v1/admin/discount-codes/${id}`, "GET", { cookie }),
  );
}

let codeCounter = 0;

/** A distinct code string per case; the (tenant, code) pair is unique. */
function nextCode(): string {
  codeCounter += 1;
  return `CODE${codeCounter.toString().padStart(4, "0")}`;
}

async function storedRow(id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    "SELECT * FROM discount_codes WHERE discount_code_id = ?",
  )
    .bind(id)
    .first();
}

async function auditRows(id: string): Promise<
  { action: string; metadata_json: string | null }[]
> {
  const rows = await env.DB.prepare(
    `SELECT action, metadata_json FROM audit_events
     WHERE resource_type = 'discount_code' AND resource_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(id)
    .all<{ action: string; metadata_json: string | null }>();

  return rows.results;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, new URL(HOST_A).hostname);
  await seedTenant(TENANT_B, new URL(HOST_B).hostname);

  adminA = await signUp("dcadmin-a@example.test");
  adminB = await signUp("dcadmin-b@example.test");
  ordinary = await signUp("dcadmin-ordinary@example.test");

  await seedAccess(adminA.userId, "tenant_admin");
  await seedAccess(adminB.userId, "tenant_admin");
  await seedAccess(ordinary.userId, "ordinary");

  await seedMembership(adminA.userId, TENANT_A, "admin");
  await seedMembership(adminB.userId, TENANT_B, "admin");
});

describe("POST /v1/admin/discount-codes", () => {
  it("creates a percentage code with every optional field", async () => {
    const code = nextCode();
    const response = await createCode(HOST_A, adminA.cookie, {
      code,
      endsAt: NOW + 1_000,
      maxUses: 100,
      minSpendMinor: 5_000,
      percentBp: 1_250,
      scope: "all",
      startsAt: NOW,
      type: "percent",
    });
    const body = (await response.json()) as DiscountCodeBody;

    expect(response.status).toBe(201);
    expect(body.discountCode.code).toBe(code);
    expect(body.discountCode.percentBp).toBe(1_250);
    expect(body.discountCode.valueMinor).toBeNull();
    expect(body.discountCode.scope).toBe("all");
    expect(body.discountCode.productIds).toBeNull();
    expect(body.discountCode.maxUses).toBe(100);
    expect(body.discountCode.minSpendMinor).toBe(5_000);
    // Active by default, matching production's admin form.
    expect(body.discountCode.active).toBe(true);
    expect(body.discountCode.usedCount).toBe(0);

    const row = await storedRow(body.discountCode.discountCodeId);
    expect(row?.tenant_id).toBe(TENANT_A);
    expect(row?.used_count).toBe(0);
  });

  it("creates a products-scoped fixed code and round-trips its product list", async () => {
    const code = nextCode();
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code,
        productIds: ["p-one", "p-two"],
        scope: "products",
        type: "fixed",
        valueMinor: 2_500,
      })
    ).json()) as DiscountCodeBody;

    expect(created.discountCode.productIds).toEqual(["p-one", "p-two"]);

    const read = (await (
      await getCode(HOST_A, adminA.cookie, created.discountCode.discountCodeId)
    ).json()) as DiscountCodeBody;

    // Read back byte-identically: a merchant who round-trips their own code
    // must not find its scope silently reshaped.
    expect(read.discountCode).toEqual(created.discountCode);
  });

  it("normalizes a lowercase code to the stored uppercase form", async () => {
    const code = nextCode();
    const body = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: `  ${code.toLowerCase()}  `,
        scope: "all",
        type: "fixed",
        valueMinor: 100,
      })
    ).json()) as DiscountCodeBody;

    // The checkout uppercases the buyer's input before looking up, so an
    // un-normalized row would be a code nobody could spend.
    expect(body.discountCode.code).toBe(code);
    expect((await storedRow(body.discountCode.discountCodeId))?.code).toBe(code);
  });

  it("returns 409 for a duplicate code within the tenant", async () => {
    const code = nextCode();
    const first = await createCode(HOST_A, adminA.cookie, {
      code,
      scope: "all",
      type: "fixed",
      valueMinor: 100,
    });
    const second = await createCode(HOST_A, adminA.cookie, {
      code,
      scope: "all",
      type: "fixed",
      valueMinor: 200,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    // The conflict names no SQL and no column.
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "conflict",
        message: "Request conflicts with the current discount code state",
      },
    });
  });

  it("allows two tenants to run the same code string", async () => {
    const code = nextCode();
    const onA = await createCode(HOST_A, adminA.cookie, {
      code,
      scope: "all",
      type: "fixed",
      valueMinor: 100,
    });
    const onB = await createCode(HOST_B, adminB.cookie, {
      code,
      scope: "all",
      type: "fixed",
      valueMinor: 900,
    });

    expect(onA.status).toBe(201);
    expect(onB.status).toBe(201);
  });

  it.each([
    ["an unknown key", { extra: 1, scope: "all", type: "fixed", valueMinor: 1 }],
    ["a writable usedCount", {
      scope: "all",
      type: "fixed",
      usedCount: 99,
      valueMinor: 1,
    }],
    ["a fixed code with no value", { scope: "all", type: "fixed" }],
    ["a fixed code carrying a percentage", {
      percentBp: 1_000,
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["a percent code with no percentage", { scope: "all", type: "percent" }],
    ["a percent code carrying a fixed value", {
      percentBp: 1_000,
      scope: "all",
      type: "percent",
      valueMinor: 1,
    }],
    ["a percentage above one hundred", {
      percentBp: 10_001,
      scope: "all",
      type: "percent",
    }],
    ["a percentage of zero", { percentBp: 0, scope: "all", type: "percent" }],
    ["a fractional percentage", {
      percentBp: 12.5,
      scope: "all",
      type: "percent",
    }],
    ["a products scope with no product list", {
      scope: "products",
      type: "fixed",
      valueMinor: 1,
    }],
    ["a products scope with an empty product list", {
      productIds: [],
      scope: "products",
      type: "fixed",
      valueMinor: 1,
    }],
    ["an all scope carrying a product list", {
      productIds: ["p"],
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["a window that ends before it starts", {
      endsAt: NOW,
      scope: "all",
      startsAt: NOW + 1,
      type: "fixed",
      valueMinor: 1,
    }],
    ["a usage cap of zero", {
      maxUses: 0,
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["a negative minimum spend", {
      minSpendMinor: -1,
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["an unknown type", { scope: "all", type: "bogus", valueMinor: 1 }],
    ["an unknown scope", { scope: "bogus", type: "fixed", valueMinor: 1 }],
    ["a non-boolean active flag", {
      active: "yes",
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["an empty code", { code: "", scope: "all", type: "fixed", valueMinor: 1 }],
    ["a code past the fifty-character bound", {
      code: "A".repeat(51),
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    }],
    ["a non-integer fixed value", {
      scope: "all",
      type: "fixed",
      valueMinor: 1.5,
    }],
    ["a negative fixed value", {
      scope: "all",
      type: "fixed",
      valueMinor: -1,
    }],
  ])("rejects %s with a 400 that echoes nothing", async (_label, overrides) => {
    const body = { code: nextCode(), ...overrides };
    const response = await createCode(HOST_A, adminA.cookie, body);

    expect(response.status).toBe(400);
    // Not the submitted values, not a field name, not a constraint name.
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
  });

  it("writes an audit row naming no code string and no value", async () => {
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: nextCode(),
        percentBp: 1_000,
        scope: "all",
        type: "percent",
      })
    ).json()) as DiscountCodeBody;

    const rows = await auditRows(created.discountCode.discountCodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("discount_code.create");
    // A code string is a capability a buyer can spend; it does not belong in an
    // append-only log platform operators read.
    expect(rows[0]?.metadata_json).toBeNull();
  });
});

describe("PATCH /v1/admin/discount-codes/{id}", () => {
  async function seedEditable(): Promise<string> {
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: nextCode(),
        percentBp: 1_000,
        scope: "all",
        type: "percent",
      })
    ).json()) as DiscountCodeBody;

    return created.discountCode.discountCodeId;
  }

  it("deactivates through the active field rather than an action verb", async () => {
    const id = await seedEditable();
    const response = await patchCode(HOST_A, adminA.cookie, id, {
      active: false,
    });
    const body = (await response.json()) as DiscountCodeBody;

    expect(response.status).toBe(200);
    expect(body.discountCode.active).toBe(false);
    expect((await storedRow(id))?.active).toBe(0);

    // And back again — activation is symmetric and idempotent.
    const reactivated = await patchCode(HOST_A, adminA.cookie, id, {
      active: true,
    });
    expect(
      ((await reactivated.json()) as DiscountCodeBody).discountCode.active,
    ).toBe(true);
  });

  it("clears the other branch's value when the type changes", async () => {
    const id = await seedEditable();
    const body = (await (
      await patchCode(HOST_A, adminA.cookie, id, {
        type: "fixed",
        valueMinor: 500,
      })
    ).json()) as DiscountCodeBody;

    expect(body.discountCode.type).toBe("fixed");
    expect(body.discountCode.valueMinor).toBe(500);
    // Not left beside the fixed value, where a future reader could take either.
    expect(body.discountCode.percentBp).toBeNull();
    expect((await storedRow(id))?.percent_bp).toBeNull();
  });

  it("clears the product list when the scope widens to all", async () => {
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: nextCode(),
        productIds: ["p-one"],
        scope: "products",
        type: "fixed",
        valueMinor: 100,
      })
    ).json()) as DiscountCodeBody;

    const body = (await (
      await patchCode(
        HOST_A,
        adminA.cookie,
        created.discountCode.discountCodeId,
        { scope: "all" },
      )
    ).json()) as DiscountCodeBody;

    expect(body.discountCode.scope).toBe("all");
    expect(body.discountCode.productIds).toBeNull();
  });

  it("rejects a type switch that leaves the merged row incoherent", async () => {
    // Widening to 'products' without naming any product would store a code
    // scoped to nothing while looking configured.
    const id = await seedEditable();
    const response = await patchCode(HOST_A, adminA.cookie, id, {
      scope: "products",
    });

    expect(response.status).toBe(400);
    // Unchanged: a refused PATCH writes nothing.
    expect((await storedRow(id))?.scope).toBe("all");
  });

  it("clears a nullable bound with an explicit null and leaves it alone when absent", async () => {
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: nextCode(),
        maxUses: 10,
        minSpendMinor: 500,
        scope: "all",
        type: "fixed",
        valueMinor: 100,
      })
    ).json()) as DiscountCodeBody;
    const id = created.discountCode.discountCodeId;

    const cleared = (await (
      await patchCode(HOST_A, adminA.cookie, id, { maxUses: null })
    ).json()) as DiscountCodeBody;

    expect(cleared.discountCode.maxUses).toBeNull();
    // The absent key was left alone rather than defaulted away.
    expect(cleared.discountCode.minSpendMinor).toBe(500);
  });

  it("never lets an admin write the usage counter", async () => {
    const id = await seedEditable();
    await env.DB.prepare(
      "UPDATE discount_codes SET used_count = 7 WHERE discount_code_id = ?",
    )
      .bind(id)
      .run();

    // usedCount is not in the allowlist, so a body carrying it is rejected
    // whole rather than having the key dropped.
    const rejected = await patchCode(HOST_A, adminA.cookie, id, {
      usedCount: 0,
    });
    expect(rejected.status).toBe(400);

    // And an ordinary edit carries the counter through untouched.
    const edited = (await (
      await patchCode(HOST_A, adminA.cookie, id, { percentBp: 2_000 })
    ).json()) as DiscountCodeBody;

    expect(edited.discountCode.usedCount).toBe(7);
    expect((await storedRow(id))?.used_count).toBe(7);
  });

  it("returns 409 when an edit collides with another code in the tenant", async () => {
    const taken = nextCode();
    await createCode(HOST_A, adminA.cookie, {
      code: taken,
      scope: "all",
      type: "fixed",
      valueMinor: 1,
    });
    const id = await seedEditable();

    const response = await patchCode(HOST_A, adminA.cookie, id, { code: taken });
    expect(response.status).toBe(409);
  });

  it("rejects an empty body", async () => {
    const id = await seedEditable();
    expect((await patchCode(HOST_A, adminA.cookie, id, {})).status).toBe(400);
  });

  it("writes an audit row naming the edited FIELDS and no values", async () => {
    const id = await seedEditable();
    await patchCode(HOST_A, adminA.cookie, id, {
      minSpendMinor: 4_000,
      percentBp: 2_000,
    });

    const rows = await auditRows(id);
    const update = rows.find((row) => row.action === "discount_code.update");
    expect(update?.metadata_json).toBe(
      JSON.stringify({ fields: ["minSpendMinor", "percentBp"] }),
    );
  });
});

describe("discount code admin authorization", () => {
  let codeOnA: string;

  beforeAll(async () => {
    const created = (await (
      await createCode(HOST_A, adminA.cookie, {
        code: nextCode(),
        scope: "all",
        type: "fixed",
        valueMinor: 100,
      })
    ).json()) as DiscountCodeBody;
    codeOnA = created.discountCode.discountCodeId;
  });

  it("hides the surface from an anonymous caller", async () => {
    for (const response of [
      await exports.default.fetch(
        adminRequest(`${HOST_A}/v1/admin/discount-codes`, "POST", {
          body: { code: "ANON", scope: "all", type: "fixed", valueMinor: 1 },
        }),
      ),
      await getCode(HOST_A, undefined, codeOnA),
      await exports.default.fetch(
        adminRequest(`${HOST_A}/v1/admin/discount-codes/${codeOnA}`, "PATCH", {
          body: { active: false },
        }),
      ),
    ]) {
      // 404 rather than 401: an unauthorized caller must not learn that the
      // surface, the tenant, or the code exists.
      expect(response.status).toBe(404);
    }
  });

  it("hides the surface from an ordinary signed-in user", async () => {
    const response = await getCode(HOST_A, ordinary.cookie, codeOnA);
    expect(response.status).toBe(404);
  });

  it("hides one tenant's code from another tenant's admin", async () => {
    // Admin B is a real, active tenant admin — of the wrong tenant. The read is
    // tenant-bound, so the code simply does not exist for them.
    const onOwnHost = await getCode(HOST_B, adminB.cookie, codeOnA);
    expect(onOwnHost.status).toBe(404);

    // And presenting B's cookie on A's hostname does not help: the tenant comes
    // from the verified hostname and B holds no membership there.
    const onForeignHost = await getCode(HOST_A, adminB.cookie, codeOnA);
    expect(onForeignHost.status).toBe(404);
  });

  it("refuses a foreign admin's edit without changing the row", async () => {
    const before = await storedRow(codeOnA);
    const response = await patchCode(HOST_A, adminB.cookie, codeOnA, {
      valueMinor: 999_999,
    });

    expect(response.status).toBe(404);
    expect(await storedRow(codeOnA)).toEqual(before);
  });

  it("rejects a cross-site write while allowing the same-origin read", async () => {
    const crossSite = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/discount-codes`, "POST", {
        body: { code: "CSRF", scope: "all", type: "fixed", valueMinor: 1 },
        cookie: adminA.cookie,
        origin: "https://evil.example",
      }),
    );
    expect(crossSite.status).toBe(404);

    const missingOrigin = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/discount-codes`, "POST", {
        body: { code: "CSRF2", scope: "all", type: "fixed", valueMinor: 1 },
        cookie: adminA.cookie,
        origin: null,
      }),
    );
    expect(missingOrigin.status).toBe(404);

    // Nothing was written by either attempt.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM discount_codes WHERE code IN ('CSRF', 'CSRF2')",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);

    // A GET with no Origin header still works: browsers do not send one on a
    // same-origin read, and the read changes nothing.
    const read = await exports.default.fetch(
      adminRequest(`${HOST_A}/v1/admin/discount-codes/${codeOnA}`, "GET", {
        cookie: adminA.cookie,
        origin: null,
      }),
    );
    expect(read.status).toBe(200);
  });

  it("returns 404 for an unknown id, a wrong method, and a malformed path", async () => {
    expect(
      (await getCode(HOST_A, adminA.cookie, "no-such-code")).status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(
          adminRequest(
            `${HOST_A}/v1/admin/discount-codes/${codeOnA}`,
            "DELETE",
            { cookie: adminA.cookie },
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(
          adminRequest(
            `${HOST_A}/v1/admin/discount-codes/${codeOnA}/extra`,
            "GET",
            { cookie: adminA.cookie },
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(
          adminRequest(`${HOST_A}/v1/admin/discount-codes`, "GET", {
            cookie: adminA.cookie,
          }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("admin-created codes price a real checkout", () => {
  it("applies a code created through the admin surface", async () => {
    // The end-to-end claim this whole checkpoint rests on: what a merchant
    // writes here is what a buyer spends there, with no manual row seeding
    // between the two.
    const code = nextCode();
    await createCode(HOST_A, adminA.cookie, {
      code,
      percentBp: 2_500,
      scope: "all",
      type: "percent",
    });

    await seedTenantStorefront();

    const response = await exports.default.fetch(
      new Request("https://storefront.dcadmin.test/v1/checkout", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.51.100.77:1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deliveryMethod: "pickup",
          discountCode: code.toLowerCase(),
          email: "e2e-buyer@example.test",
          idempotencyKey: "dcadmin-e2e-key",
          items: [{ productId: "dcadmin-product", quantity: 1 }],
        }),
      }),
    );
    const body = (await response.json()) as {
      checkout: { discountMinor: number; subtotalMinor: number };
    };

    expect(response.status).toBe(201);
    expect(body.checkout.subtotalMinor).toBe(4_000);
    expect(body.checkout.discountMinor).toBe(1_000);
  });

  async function seedTenantStorefront(): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES ('domain-dcadmin-storefront', ?, 'storefront.dcadmin.test',
        'storefront', 'verified', ?, ?)`,
    )
      .bind(TENANT_A, NOW, NOW)
      .run();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO products (
          product_id, tenant_id, status, sku, name, description,
          b2c_price_minor, currency, is_pod, weight_grams,
          allow_shipping, allow_pickup, created_at, updated_at
        ) VALUES ('dcadmin-product', ?, 'active', 'DCADMIN-SKU', 'Internal',
          NULL, 4000, 'SEK', 0, 0, 1, 1, ?, ?)`,
      ).bind(TENANT_A, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO product_publications (
          product_id, tenant_id, published, public_name, public_description,
          public_price_minor, currency, projection_version, published_at, updated_at
        ) VALUES ('dcadmin-product', ?, 1, 'Public', NULL, 4000, 'SEK', 1, ?, ?)`,
      ).bind(TENANT_A, NOW, NOW),
    ]);
  }
});
