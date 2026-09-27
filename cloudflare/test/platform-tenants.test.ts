import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminOrder,
  approveProduct,
  buyProduct,
  call,
  createPlainProduct,
  instrumentedDb,
  publishProduct,
  refundCall,
} from "./slice-harness";
import { postEvent } from "./money-fixtures";
import {
  auditCount,
  auditRows,
  bareTenant,
  callAs,
  CALLERS,
  domainByHostname,
  expectJson,
  expectOpaque404,
  makeLegallyReady,
  platform,
  SliceWorld,
  storefrontName,
  type Tenant,
  tenantRow,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP3-A — the platform tenant directory (src/routes/platform-tenants.ts,
 * src/platform/tenant-directory.ts): list, detail, edit, publish / unpublish,
 * close; the authorization matrix for EVERY CP3-A platform route; and proof
 * that the older POST actions on the tenant prefix still reach their handler.
 */

interface TenantDetailBody {
  domains: Array<{ domainId: string; hostname: string; kind: string; status: string }>;
  domainsTruncated: boolean;
  features: Array<{ defaultEnabled: boolean; enabled: boolean; key: string; source: string }>;
  settings: { returnAddressSet: boolean; vatAnswered: boolean };
  tenant: {
    catalogVersion: number;
    commissionBps: number | null;
    connect: {
      accountId: string | null;
      chargesEnabled: boolean;
      detailsSubmitted: boolean;
      payoutsEnabled: boolean;
      syncedAt: string | null;
    };
    createdAt: string;
    defaultCurrency: string;
    defaultLocale: string;
    published: boolean;
    shopName: string | null;
    status: string;
    supportEmail: string | null;
    tenantId: string;
    updatedAt: string;
    vatRateBp: number;
  };
}

interface ListBody {
  nextCursor: string | null;
  tenants: Array<{
    domainCount: number;
    domains: Array<{ hostname: string; kind: string; status: string }>;
    published: boolean;
    shopName: string | null;
    status: string;
    tenantId: string;
  }>;
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;
/** Close vs refundable orders: a shop that sells, and one for the in-batch race. */
let shopD: Tenant;
let shopE: Tenant;
/** Close vs a reserved refund that has not settled. */
let shopF: Tenant;
/** A shop the authorization matrix may change freely. */
const MATRIX = "pt-matrix";
let matrixDomainToDelete = "";
let matrixDomainToToggle = "";

beforeAll(async () => {
  const setup = await tenantWorld("pt", 6);
  world = setup.world;
  [shopA, shopB, shopC, shopD, shopE, shopF] = setup.tenants as [Tenant, Tenant, Tenant, Tenant, Tenant, Tenant];

  await bareTenant(world, MATRIX);
  for (const hostname of ["delete.pt-matrix.cp3a.test", "toggle.pt-matrix.cp3a.test"]) {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${MATRIX}/domains`, {
        body: { hostname, kind: "storefront" },
      }),
      201,
      `add ${hostname}`,
    );
  }
  matrixDomainToDelete = (await domainByHostname("delete.pt-matrix.cp3a.test"))?.domain_id ?? "";
  matrixDomainToToggle = (await domainByHostname("toggle.pt-matrix.cp3a.test"))?.domain_id ?? "";
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("authorization: every CP3-A platform route", () => {
  interface RouteCase {
    body?: unknown;
    label: string;
    method: string;
    path: () => string;
    /** What a same-origin platform session gets (a 400 proves it passed the guard). */
    platformStatus: number;
  }

  const cases: RouteCase[] = [
    { label: "list", method: "GET", path: () => "/v1/platform/tenants", platformStatus: 200 },
    { label: "detail", method: "GET", path: () => `/v1/platform/tenants/${MATRIX}`, platformStatus: 200 },
    { body: {}, label: "edit", method: "PATCH", path: () => `/v1/platform/tenants/${MATRIX}`, platformStatus: 400 },
    { label: "publish", method: "POST", path: () => `/v1/platform/tenants/${MATRIX}/publish`, platformStatus: 200 },
    { label: "unpublish", method: "POST", path: () => `/v1/platform/tenants/${MATRIX}/unpublish`, platformStatus: 200 },
    {
      body: { reason: 5 },
      label: "close",
      method: "POST",
      path: () => `/v1/platform/tenants/${MATRIX}/close`,
      platformStatus: 400,
    },
    { label: "features read", method: "GET", path: () => `/v1/platform/tenants/${MATRIX}/features`, platformStatus: 200 },
    {
      body: { features: {} },
      label: "features write",
      method: "PUT",
      path: () => `/v1/platform/tenants/${MATRIX}/features`,
      platformStatus: 400,
    },
    { label: "domains read", method: "GET", path: () => `/v1/platform/tenants/${MATRIX}/domains`, platformStatus: 200 },
    {
      label: "domain delete",
      method: "DELETE",
      path: () => `/v1/platform/tenants/${MATRIX}/domains/${matrixDomainToDelete}`,
      platformStatus: 204,
    },
    {
      label: "domain disable",
      method: "POST",
      path: () => `/v1/platform/tenants/${MATRIX}/domains/${matrixDomainToToggle}/disable`,
      platformStatus: 200,
    },
    {
      label: "domain enable",
      method: "POST",
      path: () => `/v1/platform/tenants/${MATRIX}/domains/${matrixDomainToToggle}/enable`,
      platformStatus: 200,
    },
    {
      label: "hostname lookup",
      method: "GET",
      path: () => "/v1/platform/domains/lookup?hostname=toggle.pt-matrix.cp3a.test",
      platformStatus: 200,
    },
    { body: {}, label: "domain move", method: "POST", path: () => "/v1/platform/domains/move", platformStatus: 400 },
  ];

  it.each(cases)("$label: $method answers the opaque 404 to everyone but a platform session", async (route) => {
    const before = await auditCount();
    for (const who of CALLERS) {
      const response = await callAs(world, who, shopA, route.method, route.path(), { body: route.body });
      if (who === "platform") {
        const text = await response.text();
        expect(response.status, `${who} ${route.label}: ${text.slice(0, 300)}`).toBe(route.platformStatus);
      } else {
        await expectOpaque404(response, `${who} ${route.label}`);
        expect(await auditCount(), `${who} ${route.label} wrote nothing`).toBe(before);
      }
    }
  });

  it.each(cases.filter((route) => route.method !== "GET"))(
    "$label: a cross-origin or origin-less $method is refused like the older routes refuse it",
    async (route) => {
      const before = await auditCount();
      for (const origin of ["https://evil.test", null]) {
        await expectOpaque404(
          await callAs(world, "platform", shopA, route.method, route.path(), { body: route.body, origin }),
          `${route.label} origin=${origin}`,
        );
      }
      // The older tenant POST refuses the same way (same body, same status).
      await expectOpaque404(
        await callAs(world, "platform", shopA, "POST", `/v1/platform/tenants/${MATRIX}/suspend`, {
          origin: "https://evil.test",
        }),
        "older route, cross-origin",
      );
      expect(await auditCount()).toBe(before);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the older POST actions on the tenant prefix still reach their handler", () => {
  it("create, suspend, activate, add domain and grant admin all answer as before", async () => {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: "legacy.shops.cp3a.test", shopName: "Legacy", tenantId: "pt-legacy" },
      }),
      201,
      "create",
    );
    const suspended = await expectJson<{ tenant: { status: string } }>(
      await platform(world, "POST", "/v1/platform/tenants/pt-legacy/suspend"),
      200,
      "suspend",
    );
    expect(suspended.tenant.status).toBe("suspended");
    const activated = await expectJson<{ tenant: { status: string } }>(
      await platform(world, "POST", "/v1/platform/tenants/pt-legacy/activate"),
      200,
      "activate",
    );
    expect(activated.tenant.status).toBe("active");
    const domain = await expectJson<{ domain: { hostname: string; kind: string } }>(
      await platform(world, "POST", "/v1/platform/tenants/pt-legacy/domains", {
        body: { hostname: "admin.legacy.cp3a.test", kind: "admin" },
      }),
      201,
      "add domain",
    );
    expect(domain.domain).toMatchObject({ hostname: "admin.legacy.cp3a.test", kind: "admin" });
    const granted = await expectJson<{ membership: { tenantId: string; userId: string } }>(
      await platform(world, "POST", "/v1/platform/tenants/pt-legacy/admins", {
        body: { userId: shopB.adminUserId },
      }),
      201,
      "grant admin",
    );
    expect(granted.membership).toMatchObject({ tenantId: "pt-legacy", userId: shopB.adminUserId });

    expect((await auditRows("pt-legacy")).map((row) => row.action)).toEqual([
      "tenant.provision",
      "tenant.suspend",
      "tenant.activate",
      "tenant.domain_add",
      "tenant.admin_grant",
    ]);
  });

  it.each([
    ["POST", "/v1/platform/tenants/pt-legacy"],
    ["PUT", "/v1/platform/tenants"],
    ["DELETE", "/v1/platform/tenants/pt-legacy"],
    ["GET", "/v1/platform/tenants/pt-legacy/suspend"],
    ["PUT", "/v1/platform/tenants/pt-legacy/domains"],
    ["POST", "/v1/platform/tenants/pt-legacy/domains/x"],
    ["GET", "/v1/platform/tenants/pt-legacy/features/extra"],
    ["HEAD", "/v1/platform/tenants"],
  ])("a method no route owns still falls through to the 404: %s %s", async (method, path) => {
    const response = await platform(world, method, path);
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/platform/tenants — the directory", () => {
  it("lists every tenant by id with its status, go-live flag and hostnames", async () => {
    const body = await expectJson<ListBody>(await platform(world, "GET", "/v1/platform/tenants"), 200, "list");
    const ids = body.tenants.map((tenant) => tenant.tenantId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining([shopA.tenantId, shopB.tenantId, MATRIX]));

    const a = body.tenants.find((tenant) => tenant.tenantId === shopA.tenantId);
    expect(a).toEqual({
      domainCount: 1,
      domains: [{ hostname: shopA.host, kind: "storefront", status: "verified" }],
      published: true,
      shopName: shopA.shopName,
      status: "active",
      tenantId: shopA.tenantId,
    });
    // Directory rows carry no money or Connect facts (those are on the detail).
    expect(JSON.stringify(body)).not.toMatch(/acct_|commission|stripe/i);
  });

  it("pages with a keyset cursor that visits every tenant exactly once", async () => {
    const all = await expectJson<ListBody>(await platform(world, "GET", "/v1/platform/tenants?limit=100"), 200, "all");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const page: ListBody = await expectJson<ListBody>(
        await platform(world, "GET", `/v1/platform/tenants${query}`),
        200,
        "page",
      );
      expect(page.tenants.length).toBeLessThanOrEqual(2);
      seen.push(...page.tenants.map((tenant) => tenant.tenantId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.tenants.map((tenant) => tenant.tenantId));
    expect(all.nextCursor).toBeNull();
  });

  it("filters by status", async () => {
    await bareTenant(world, "pt-filtered");
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/pt-filtered/suspend"), 200, "suspend");
    const body = await expectJson<ListBody>(
      await platform(world, "GET", "/v1/platform/tenants?status=suspended"),
      200,
      "filtered",
    );
    expect(body.tenants.map((tenant) => tenant.tenantId)).toContain("pt-filtered");
    expect(body.tenants.every((tenant) => tenant.status === "suspended")).toBe(true);
  });

  it.each([
    ["limit=0"],
    ["limit=101"],
    ["limit=abc"],
    ["limit=1.5"],
    ["cursor=Not-A-Tenant"],
    ["status=disabled"],
    ["tenantId=pt-a"],
  ])("refuses the query %s", async (query) => {
    await expectJson(await platform(world, "GET", `/v1/platform/tenants?${query}`), 400, query);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/platform/tenants/:tenantId — the detail", () => {
  it("shows the platform facts, the domains, the effective features and the gate answers", async () => {
    const body = await expectJson<TenantDetailBody>(
      await platform(world, "GET", `/v1/platform/tenants/${shopA.tenantId}`),
      200,
      "detail",
    );
    expect(body.tenant).toMatchObject({
      commissionBps: null,
      connect: {
        accountId: shopA.accountId,
        chargesEnabled: true,
        detailsSubmitted: true,
        payoutsEnabled: true,
        syncedAt: null,
      },
      defaultCurrency: "SEK",
      defaultLocale: "sv-SE",
      published: true,
      shopName: shopA.shopName,
      status: "active",
      supportEmail: null,
      tenantId: shopA.tenantId,
      vatRateBp: 2500,
    });
    expect(body.tenant.catalogVersion).toBeGreaterThanOrEqual(1);
    expect(body.domains.map((domain) => domain.hostname)).toEqual([shopA.host]);
    expect(body.domainsTruncated).toBe(false);
    expect(body.features.map((feature) => feature.key)).toEqual([
      "abandonedCheckout",
      "contentStudio",
      "discountCodes",
      "marketingMaterials",
      "pod",
      "productReviews",
    ]);
    expect(body.settings).toEqual({ returnAddressSet: false, vatAnswered: false });
  });

  it("reports that the gate fields are answered without showing their text", async () => {
    await expectJson(
      await call(world, "PUT", "https://admin.slice.test/v1/admin/settings", {
        body: { returnAddress: "Returgatan 1\n123 45 Returby", vatRegistered: false },
        cookie: shopB.adminCookie,
        shopId: shopB.tenantId,
      }),
      200,
      "seller writes settings",
    );
    const response = await platform(world, "GET", `/v1/platform/tenants/${shopB.tenantId}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).settings).toEqual({ returnAddressSet: true, vatAnswered: true });
    expect(text).not.toContain("Returgatan");
  });

  it.each([
    ["an unknown tenant", "/v1/platform/tenants/pt-nobody"],
    ["an uppercase id", "/v1/platform/tenants/PT-A"],
    ["a double-encoded id", "/v1/platform/tenants/%2570t-a"],
  ])("answers the opaque 404 for %s", async (_label, path) => {
    await expectOpaque404(await platform(world, "GET", path), path);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PATCH /v1/platform/tenants/:tenantId", () => {
  it("edits the name, support email, VAT rate and commission, audited with before and after", async () => {
    const before = await tenantRow(shopC.tenantId);
    const body = await expectJson<TenantDetailBody>(
      await platform(world, "PATCH", `/v1/platform/tenants/${shopC.tenantId}`, {
        body: {
          commissionBps: 300,
          shopName: "Omdöpt Butik",
          supportEmail: "Support@Shop-C.Test",
          vatRateBp: 1200,
        },
      }),
      200,
      "patch",
    );
    expect(body.tenant).toMatchObject({
      commissionBps: 300,
      shopName: "Omdöpt Butik",
      supportEmail: "support@shop-c.test",
      vatRateBp: 1200,
    });
    // The name is on the storefront, so its version moved (0025 trigger).
    expect(body.tenant.catalogVersion).toBeGreaterThan(before?.catalog_version ?? Infinity);
    expect(await storefrontName(world, shopC.host)).toBe("Omdöpt Butik");

    const [audit] = await auditRows(shopC.tenantId, "tenant.update");
    expect(audit).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: {
        changes: {
          commissionBps: { from: null, to: 300 },
          shopName: { from: shopC.shopName, to: "Omdöpt Butik" },
          supportEmail: { from: null, to: "support@shop-c.test" },
          vatRateBp: { from: 2500, to: 1200 },
        },
      },
      resourceId: shopC.tenantId,
      resourceType: "tenant",
    });
  });

  it("null clears the commission override and the support email; absent fields are untouched", async () => {
    const body = await expectJson<TenantDetailBody>(
      await platform(world, "PATCH", `/v1/platform/tenants/${shopC.tenantId}`, {
        body: { commissionBps: null, supportEmail: null },
      }),
      200,
      "clear",
    );
    expect(body.tenant).toMatchObject({
      commissionBps: null,
      shopName: "Omdöpt Butik",
      supportEmail: null,
      vatRateBp: 1200,
    });
  });

  it.each([
    ["an empty body", {}],
    ["an unknown key", { status: "active" }],
    ["a published flag (its own route)", { published: false }],
    ["a null VAT rate", { vatRateBp: null }],
    ["a VAT rate above 100 %", { vatRateBp: 10_001 }],
    ["a negative VAT rate", { vatRateBp: -1 }],
    ["a fractional VAT rate", { vatRateBp: 12.5 }],
    ["a VAT rate as text", { vatRateBp: "2500" }],
    ["a commission above 100 %", { commissionBps: 10_001 }],
    ["a commission above the 8 % cap (D45)", { commissionBps: 801 }],
    ["a fractional commission", { commissionBps: 2.5 }],
    ["an empty name", { shopName: "" }],
    ["a blank name", { shopName: "   " }],
    ["a long name", { shopName: "n".repeat(201) }],
    ["a null name", { shopName: null }],
    ["an address without @", { supportEmail: "support.shop.test" }],
    ["an address with a space", { supportEmail: "sup port@shop.test" }],
  ])("refuses %s and changes nothing", async (_label, patch) => {
    const before = await tenantRow(shopC.tenantId);
    await expectJson(
      await platform(world, "PATCH", `/v1/platform/tenants/${shopC.tenantId}`, { body: patch }),
      400,
      "invalid patch",
    );
    expect(await tenantRow(shopC.tenantId)).toEqual(before);
  });

  it("answers the opaque 404 for an unknown tenant", async () => {
    await expectOpaque404(
      await platform(world, "PATCH", "/v1/platform/tenants/pt-nobody", { body: { vatRateBp: 600 } }),
      "unknown",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("publish / unpublish — the go-live gate", () => {
  it("unpublish hides the catalogue on the very next request, publish brings it back; both bump catalog_version", async () => {
    const productId = await createPlainProduct(world, shopA, { name: "Mugg", priceMinor: 14_900, sku: "PT-MUG" });
    await publishProduct(world, shopA, productId);
    await approveProduct(world, productId);

    const live = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`);
    expect(live.status).toBe(200);
    const etag = live.headers.get("etag");
    await live.body?.cancel();
    expect(etag).not.toBeNull();

    const versionBefore = (await tenantRow(shopA.tenantId))?.catalog_version ?? 0;
    const hidden = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/unpublish`),
      200,
      "unpublish",
    );
    expect(hidden.tenant.published).toBe(false);
    expect(hidden.tenant.catalogVersion).toBeGreaterThan(versionBefore);

    // Next request: the product is gone — a 404, not a 304 on the old ETag.
    const gone = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`, {
      headers: { "if-none-match": etag as string },
    });
    expect(gone.status).toBe(404);
    await gone.body?.cancel();
    const list = await expectJson<{ products: unknown[] }>(
      await call(world, "GET", `${shopA.origin}/v1/products`),
      200,
      "list while unpublished",
    );
    expect(list.products).toEqual([]);

    const versionHidden = hidden.tenant.catalogVersion;
    const shown = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/publish`),
      200,
      "publish",
    );
    expect(shown.tenant.published).toBe(true);
    expect(shown.tenant.catalogVersion).toBeGreaterThan(versionHidden);
    const back = await call(world, "GET", `${shopA.origin}/v1/products/${productId}`);
    expect(back.status).toBe(200);
    await back.body?.cancel();

    const actions = (await auditRows(shopA.tenantId))
      .map((row) => row.action)
      .filter((action) => action.startsWith("tenant.") && action.endsWith("publish"));
    expect(actions).toEqual(["tenant.unpublish", "tenant.publish"]);
  });

  it("answers the opaque 404 for an unknown tenant", async () => {
    await expectOpaque404(await platform(world, "POST", "/v1/platform/tenants/pt-nobody/publish"), "unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /v1/platform/tenants/:tenantId/close", () => {
  it("closes an active shop for good: storefront, admin session and every write stop", async () => {
    const before = await tenantRow(shopC.tenantId);
    const closed = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopC.tenantId}/close`, {
        body: { reason: "Butiken lades ner (ärende 42)" },
      }),
      200,
      "close",
    );
    expect(closed.tenant.status).toBe("closed");
    expect(closed.tenant.catalogVersion).toBeGreaterThan(before?.catalog_version ?? Infinity);

    const [audit] = await auditRows(shopC.tenantId, "tenant.close");
    expect(audit).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { from: "active" },
      reason: "Butiken lades ner (ärende 42)",
    });

    expect(await storefrontName(world, shopC.host)).toBeNull();
    await expectOpaque404(
      await call(world, "GET", "https://admin.slice.test/v1/admin/settings", {
        cookie: shopC.adminCookie,
        shopId: shopC.tenantId,
      }),
      "the shop's own admin",
    );

    for (const [method, path, body] of [
      ["PATCH", `/v1/platform/tenants/${shopC.tenantId}`, { shopName: "Zombie" }],
      ["POST", `/v1/platform/tenants/${shopC.tenantId}/publish`, undefined],
      ["POST", `/v1/platform/tenants/${shopC.tenantId}/unpublish`, undefined],
      ["PUT", `/v1/platform/tenants/${shopC.tenantId}/features`, { features: { pod: true } }],
    ] as const) {
      const response = await platform(world, method, path, { body });
      const refused = await expectJson<{ error: { code: string } }>(response, 409, `${method} ${path}`);
      expect(refused.error.code).toBe("conflict");
    }
    expect((await tenantRow(shopC.tenantId))?.shop_name).toBe("Omdöpt Butik");
  });

  it("closing a closed shop again answers 200 and writes nothing", async () => {
    const audits = await auditCount();
    const again = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopC.tenantId}/close`),
      200,
      "close again",
    );
    expect(again.tenant.status).toBe("closed");
    expect(await auditCount()).toBe(audits);
  });

  it("closed is final: the older activate / suspend actions cannot reopen it", async () => {
    const audits = await auditCount();
    for (const action of ["activate", "suspend"]) {
      // The older handler refuses a closed shop with 409 tenant_closed
      // (setTenantStatus, reviewer consolidation of CP3-A wiring item 2); the
      // 0032 trigger is the backstop underneath it.
      const refused = await expectJson<{ error: { code: string } }>(
        await platform(world, "POST", `/v1/platform/tenants/${shopC.tenantId}/${action}`),
        409,
        action,
      );
      expect(refused.error.code).toBe("tenant_closed");
      expect((await tenantRow(shopC.tenantId))?.status).toBe("closed");
    }
    expect(await auditCount()).toBe(audits);
    await expect(
      env.DB.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").bind(shopC.tenantId).run(),
    ).rejects.toThrow(/closed tenant cannot be reopened/);
  });

  it("closes a suspended shop and a never-activated one", async () => {
    await bareTenant(world, "pt-close-suspended");
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/pt-close-suspended/suspend"), 200, "suspend");
    const fromSuspended = await expectJson<TenantDetailBody>(
      await platform(world, "POST", "/v1/platform/tenants/pt-close-suspended/close", { body: {} }),
      200,
      "close suspended",
    );
    expect(fromSuspended.tenant.status).toBe("closed");
    expect((await auditRows("pt-close-suspended", "tenant.close"))[0]?.metadata).toEqual({ from: "suspended" });

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO tenants (tenant_id, status, shop_name, created_at, updated_at)
       VALUES ('pt-provisioning', 'provisioning', 'Halvfärdig', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const fromProvisioning = await expectJson<TenantDetailBody>(
      await platform(world, "POST", "/v1/platform/tenants/pt-provisioning/close"),
      200,
      "close provisioning",
    );
    expect(fromProvisioning.tenant.status).toBe("closed");
  });

  it.each([
    ["a non-object body", "pt-close-array", [1]],
    ["an unknown key", "pt-close-unknown", { force: true, reason: "x" }],
    ["an empty reason", "pt-close-empty", { reason: "  " }],
    ["a long reason", "pt-close-long", { reason: "r".repeat(501) }],
  ])("refuses %s", async (_label, tenantId, body) => {
    await bareTenant(world, tenantId);
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${tenantId}/close`, { body }), 400, "bad");
    expect((await tenantRow(tenantId))?.status).toBe("active");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("close refuses while a buyer could still be refunded", () => {
  const PRICE_MINOR = 20_000;

  /** A published, approved product in a shop whose checkout is open (both legal gates). */
  async function sellingProduct(tenant: Tenant, sku: string): Promise<string> {
    await makeLegallyReady(world, tenant);
    const productId = await createPlainProduct(world, tenant, { name: "Tröja", priceMinor: PRICE_MINOR, sku });
    await publishProduct(world, tenant, productId);
    await approveProduct(world, productId);
    return productId;
  }

  /**
   * The close attempt is refused with the code, and leaves no trace. `env`
   * swaps the DB; with it, other audit rows may appear meanwhile (the race
   * test buys an order mid-close), so only the close's own row is checked.
   */
  async function expectCloseRefused(tenant: Tenant, label: string, env?: Env): Promise<void> {
    const status = (await tenantRow(tenant.tenantId))?.status;
    const audits = await auditCount();
    const body = await expectJson<{ error: { code: string } }>(
      await platform(world, "POST", `/v1/platform/tenants/${tenant.tenantId}/close`, { env }),
      409,
      label,
    );
    expect(body.error.code, label).toBe("tenant_has_refundable_orders");
    expect((await tenantRow(tenant.tenantId))?.status, `${label}: status unchanged`).toBe(status);
    if (env === undefined) {
      expect(await auditCount(), `${label}: no audit row`).toBe(audits);
    }
    expect(await auditRows(tenant.tenantId, "tenant.close"), label).toEqual([]);
  }

  it("a paid order blocks close — also while suspended — and so does a partial refund; a full refund frees it", async () => {
    const productId = await sellingProduct(shopD, "PT-CLOSE-TEE");
    const order = await buyProduct(world, shopD, productId);
    expect(order.totalMinor).toBe(PRICE_MINOR);

    await expectCloseRefused(shopD, "paid order");

    // Suspension is the tool for a shop with live orders — and it does not
    // make the shop closable either.
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopD.tenantId}/suspend`), 200, "suspend");
    await expectCloseRefused(shopD, "paid order, shop suspended");
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopD.tenantId}/activate`), 200, "activate");

    const partial = 5_000;
    await expectJson(await refundCall(world, shopD, order.orderId, partial), 201, "partial refund");
    expect((await adminOrder(world, shopD, order.orderId)).money).toMatchObject({
      refundableMinor: PRICE_MINOR - partial,
      refundedMinor: partial,
    });
    await expectCloseRefused(shopD, "partially refunded order");

    await expectJson(await refundCall(world, shopD, order.orderId, PRICE_MINOR - partial), 201, "refund the rest");
    expect((await adminOrder(world, shopD, order.orderId)).money.refundableMinor).toBe(0);

    const closed = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopD.tenantId}/close`),
      200,
      "close after the full refund",
    );
    expect(closed.tenant.status).toBe("closed");
    expect(await auditRows(shopD.tenantId, "tenant.close")).toHaveLength(1);
  });

  it("the check is inside the batch: an order paid after the route's read and before its commit still blocks", async () => {
    const productId = await sellingProduct(shopE, "PT-RACE-TEE");
    let paid = false;
    // Every read the route makes happens first; the order is bought at the
    // last moment — just before the close batch reaches D1.
    const { db, ops } = instrumentedDb(async (op) => {
      if (!paid && op.kind === "batch" && op.sql.some((sql) => sql.includes("SET status = 'closed'"))) {
        paid = true;
        await buyProduct(world, shopE, productId);
      }
    });

    await expectCloseRefused(shopE, "order paid mid-close", world.with({ DB: db }));
    expect(paid).toBe(true);
    // No read of orders happened before the batch: the refusal came from the
    // batch's own guard.
    const closeBatch = ops.findIndex((op) => op.kind === "batch" && op.sql.some((sql) => sql.includes("SET status = 'closed'")));
    expect(ops.slice(0, closeBatch).some((op) => op.sql.some((sql) => /FROM orders/.test(sql)))).toBe(false);
  });

  it("a reserved refund that has not settled still blocks close; once it succeeds the shop closes", async () => {
    const productId = await sellingProduct(shopF, "PT-RESERVED-TEE");
    const order = await buyProduct(world, shopF, productId);

    // Stripe answers "pending": the full amount is reserved, nothing settled.
    world.stripe.refundStatus = "pending";
    const refund = await expectJson<{ refund: { refundId: string; state: string } }>(
      await refundCall(world, shopF, order.orderId, PRICE_MINOR),
      201,
      "full refund, pending at Stripe",
    );
    expect(refund.refund.state).toBe("submitted");
    // By the refund rule nothing is refundable any more — the balance is
    // fully reserved — yet close must wait: Stripe may still fail the refund
    // and release the reservation.
    expect((await adminOrder(world, shopF, order.orderId)).money).toMatchObject({
      refundableMinor: 0,
      refundedMinor: 0,
      refundPendingMinor: PRICE_MINOR,
    });
    await expectCloseRefused(shopF, "reserved, unsettled full refund");

    // Stripe settles it (refund.updated → succeeded): now nothing can come back.
    const op = await env.DB.prepare("SELECT stripe_refund_id FROM refund_operations WHERE id = ?")
      .bind(refund.refund.refundId)
      .first<{ stripe_refund_id: string }>();
    const settled = world.stripe.setRefundStatus(op?.stripe_refund_id ?? "", "succeeded");
    const settlement = await postEvent("refund.updated", { ...settled, object: "refund" }, { env: world.env });
    expect(settlement.response.status).toBe(200);
    expect((await adminOrder(world, shopF, order.orderId)).money).toMatchObject({
      refundedMinor: PRICE_MINOR,
      refundPendingMinor: 0,
    });

    const closed = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopF.tenantId}/close`),
      200,
      "close after the refund succeeded",
    );
    expect(closed.tenant.status).toBe("closed");
  });

  it("every dispute status blocks close — open ones included — except a lost one", async () => {
    // Its own paid order (shopE may also hold the race test's): the dispute is
    // set on EVERY order of the shop, so each case is decided by the status alone.
    await buyProduct(world, shopE, await sellingProduct(shopE, "PT-DISPUTE-TEE"));
    const setDispute = (status: string) =>
      env.DB.prepare("UPDATE orders SET dispute_status = ? WHERE tenant_id = ?").bind(status, shopE.tenantId).run();

    for (const status of [
      // an open chargeback: not refundable now, refundable again if the shop wins
      "needs_response",
      "under_review",
      // inquiries, open or closed
      "warning_needs_response",
      "warning_under_review",
      "warning_closed",
      // closed in the shop's favour: the money is back, refundable
      "won",
      "prevented",
      // a status Stripe might add later: fail closed
      "some_future_status",
    ]) {
      await setDispute(status);
      await expectCloseRefused(shopE, `dispute ${status}`);
    }

    // A lost chargeback: the money went back to the buyer; nothing is stranded.
    await setDispute("lost");
    const closed = await expectJson<TenantDetailBody>(
      await platform(world, "POST", `/v1/platform/tenants/${shopE.tenantId}/close`),
      200,
      "close after a lost dispute",
    );
    expect(closed.tenant.status).toBe("closed");
  });
});
