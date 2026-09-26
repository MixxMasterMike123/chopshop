import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker, { Internal } from "../src/index";
import { createApp, PUBLIC_STOREFRONT_ALLOWED } from "../src/app";
import {
  hasTenantHeader,
  stripTenantHeaders,
} from "../src/lib/tenant-headers";

/**
 * PLAN §2.1: the tenant is never request-supplied.
 *
 * Two storefronts with different names, so a response always says whose
 * storefront it is. Every "wrong tenant" case below points a tenant header at
 * the OTHER shop and asserts the hostname's shop was served anyway.
 */
const TENANT_A = "tenant-entry-a";
const TENANT_B = "tenant-entry-b";
const HOST_A = "a.entry.test";
const HOST_B = "b.entry.test";
const NOW = 1_787_500_000_000;

const TENANT_HEADERS = {
  "X-Tenant-Host": HOST_B,
  "X-Tenant-Id": TENANT_B,
  "x-tenant-override": TENANT_B,
};

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
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

async function storefrontName(response: Response): Promise<string> {
  const body = await response.json<{ storefront: { name: string } }>();
  return body.storefront.name;
}

beforeAll(async () => {
  await seedTenant(TENANT_A, HOST_A);
  await seedTenant(TENANT_B, HOST_B);
});

describe("tenant header stripping", () => {
  it("removes every x-tenant-* header, case-insensitively, and nothing else", () => {
    const original = new Request(`https://${HOST_A}/v1/storefront`, {
      headers: {
        ...TENANT_HEADERS,
        cookie: "session=kept",
        "x-shop-id": "kept-shop",
        "x-tenantid": "no-dash-so-kept",
      },
    });

    const stripped = stripTenantHeaders(original);

    expect(hasTenantHeader(stripped.headers)).toBe(false);
    expect(stripped.headers.get("x-tenant-id")).toBeNull();
    expect(stripped.headers.get("x-tenant-host")).toBeNull();
    expect(stripped.headers.get("x-tenant-override")).toBeNull();
    expect(stripped.headers.get("cookie")).toBe("session=kept");
    expect(stripped.headers.get("x-shop-id")).toBe("kept-shop");
    expect(stripped.headers.get("x-tenantid")).toBe("no-dash-so-kept");
    expect(stripped.url).toBe(original.url);
  });

  it("returns the very same request when there is nothing to strip", () => {
    const request = new Request(`https://${HOST_A}/v1/storefront`);
    expect(stripTenantHeaders(request)).toBe(request);
  });

  it("carries the method and the unread body across the copy", async () => {
    const stripped = stripTenantHeaders(
      new Request(`https://${HOST_A}/v1/checkout`, {
        body: '{"raw":"bytes"}',
        headers: { "X-Tenant-Id": TENANT_B },
        method: "POST",
      }),
    );

    expect(stripped.method).toBe("POST");
    await expect(stripped.text()).resolves.toBe('{"raw":"bytes"}');
  });
});

describe("handler-layer guard", () => {
  /**
   * The app itself refuses a request that still carries a tenant header. This
   * is what makes the entrypoint tests below meaningful: they can only be
   * served for the hostname's tenant if the entrypoint removed the header
   * before the app saw it. Delete the strip and every one of them turns into
   * this 404.
   */
  it("answers the opaque 404 when a tenant header reaches the router", async () => {
    const app = createApp({ surface: "public" });
    const response = await app.fetch(
      new Request(`https://${HOST_A}/v1/storefront`, {
        headers: { "X-Tenant-Id": TENANT_A },
      }),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });
});

describe("public entrypoint", () => {
  it("serves the HOSTNAME's tenant when a tenant header names another", async () => {
    const response = await worker.fetch(
      new Request(`https://${HOST_A}/v1/storefront`, {
        headers: TENANT_HEADERS,
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${TENANT_A}`);
  });

  it("serves the hostname's tenant through the deployed default export too", async () => {
    const response = await exports.default.fetch(
      new Request(`https://${HOST_A}/v1/storefront`, {
        headers: TENANT_HEADERS,
      }),
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${TENANT_A}`);
  });

  it("gives an unknown hostname the opaque 404 whatever tenant header it sends", async () => {
    const response = await worker.fetch(
      new Request("https://unknown.entry.test/v1/storefront", {
        headers: { "X-Tenant-Host": HOST_A, "X-Tenant-Id": TENANT_A },
      }),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Storefront not found" },
    });
  });

  it("does not let a tenant header steer a product read to the other shop", async () => {
    const response = await worker.fetch(
      new Request(`https://${HOST_B}/v1/products`, {
        headers: { "X-Tenant-Id": TENANT_A },
      }),
      env,
    );

    // B has no products; A's list would be equally empty, so pin the tenant by
    // the storefront read as well — the point is the 200 for the host's shop.
    expect(response.status).toBe(200);
    const storefront = await worker.fetch(
      new Request(`https://${HOST_B}/v1/storefront`, {
        headers: { "X-Tenant-Id": TENANT_A },
      }),
      env,
    );
    await expect(storefrontName(storefront)).resolves.toBe(`Shop ${TENANT_B}`);
  });
});

describe("internal entrypoint", () => {
  it("is exported as a WorkerEntrypoint class", () => {
    expect(typeof Internal).toBe("function");
  });

  it("resolves the tenant from the hostname and strips tenant headers over the binding", async () => {
    const response = await exports.Internal.fetch(
      new Request(`https://${HOST_A}/v1/storefront`, {
        headers: TENANT_HEADERS,
      }),
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${TENANT_A}`);
  });

  it("serves the other tenant only when the HOSTNAME is the other tenant's", async () => {
    const response = await exports.Internal.fetch(
      new Request(`https://${HOST_B}/v1/storefront`, {
        headers: { "X-Tenant-Id": TENANT_A },
      }),
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${TENANT_B}`);
  });

  it("answers the opaque 404 for an unknown hostname", async () => {
    const response = await exports.Internal.fetch(
      new Request("https://unknown.entry.test/v1/storefront"),
    );

    expect(response.status).toBe(404);
  });
});

describe("storefront surface switch (PLAN §2.1 TODO)", () => {
  it("is open to the public entrypoint at CP1", () => {
    expect(PUBLIC_STOREFRONT_ALLOWED).toBe(true);
  });

  it("confines storefront routes to the internal surface once flipped", async () => {
    const closedPublic = createApp({
      publicStorefrontAllowed: false,
      surface: "public",
    });
    const closedInternal = createApp({
      publicStorefrontAllowed: false,
      surface: "internal",
    });

    for (const path of ["/v1/storefront", "/v1/products", "/v1/products/x"]) {
      const refused = await closedPublic.fetch(
        new Request(`https://${HOST_A}${path}`),
        env,
      );
      expect(refused.status, path).toBe(404);
      await expect(refused.json()).resolves.toEqual({
        error: { code: "not_found", message: "Route not found" },
      });
    }

    const checkout = await closedPublic.fetch(
      new Request(`https://${HOST_A}/v1/checkout`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
    );
    expect(checkout.status).toBe(404);
    await expect(checkout.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });

    const served = await closedInternal.fetch(
      new Request(`https://${HOST_A}/v1/storefront`),
      env,
    );
    expect(served.status).toBe(200);
    await expect(storefrontName(served)).resolves.toBe(`Shop ${TENANT_A}`);
  });

  it("never gates the non-storefront routes on the surface", async () => {
    const closedPublic = createApp({
      publicStorefrontAllowed: false,
      surface: "public",
    });

    const health = await closedPublic.fetch(
      new Request(`https://${HOST_A}/health`),
      env,
    );
    expect(health.status).toBe(200);
  });
});
