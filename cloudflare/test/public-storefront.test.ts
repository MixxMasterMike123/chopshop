import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const NOW = 1_787_000_000_000;

async function seedStorefront(
  tenantId: string,
  hostname: string,
  name: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, settings_json, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?, ?)`,
    ).bind(
      tenantId,
      name,
      `private-${tenantId}@example.test`,
      JSON.stringify({ privatePaymentSetting: "must-not-leak" }),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

describe("GET /v1/storefront", () => {
  it("returns only allowlisted public fields for the hostname tenant", async () => {
    await seedStorefront("tenant-route-a", "a.route.test", "Store A");
    await seedStorefront("tenant-route-b", "b.route.test", "Store B");

    const response = await exports.default.fetch(
      new Request("https://a.route.test/v1/storefront", {
        headers: {
          "x-forwarded-host": "b.route.test",
          "x-shop-id": "tenant-route-b",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      storefront: {
        currency: "SEK",
        locale: "sv-SE",
        name: "Store A",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain("tenant-route-a");
  });

  it("fails closed for an unknown hostname", async () => {
    const response = await exports.default.fetch(
      "https://unknown.route.test/v1/storefront",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Storefront not found",
      },
    });
  });

  it("does not expose the route through another method", async () => {
    await seedStorefront("tenant-route-post", "post.route.test", "Post Store");
    const response = await exports.default.fetch(
      new Request("https://post.route.test/v1/storefront", { method: "POST" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });
});
