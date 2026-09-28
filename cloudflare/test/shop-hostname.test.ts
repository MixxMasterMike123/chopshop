import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  isShopSegment,
  requestOnHostname,
  shopStorefrontHostname,
} from "../src/tenancy/shop-hostname";

/**
 * CP4-E / D77 — the shop segment of a shared-host storefront path, mapped to
 * the shop's verified storefront hostname. Every case that must answer nothing
 * is here, each with a shop that would otherwise answer.
 */
const NOW = 1_787_600_000_000;

async function seedTenant(tenantId: string, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
       tenant_id, status, shop_name, default_locale, default_currency,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, status, `Shop ${tenantId}`, NOW, NOW)
    .run();
}

async function seedDomain(
  tenantId: string,
  hostname: string,
  kind: string,
  status: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_domains (
       domain_id, tenant_id, hostname, kind, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(`domain-${hostname}`, tenantId, hostname, kind, status, NOW, NOW)
    .run();
}

beforeAll(async () => {
  // The one that answers.
  await seedTenant("sh-active", "active");
  await seedDomain("sh-active", "sh-active.shop.test", "storefront", "verified");

  // Several verified storefront domains: the lowest hostname wins.
  await seedTenant("sh-several", "active");
  await seedDomain("sh-several", "zz.sh-several.test", "storefront", "verified");
  await seedDomain("sh-several", "aa.sh-several.test", "storefront", "verified");
  await seedDomain("sh-several", "00.sh-several.test", "storefront", "pending");
  await seedDomain("sh-several", "0.sh-several.test", "admin", "verified");

  // Refusals.
  await seedTenant("sh-suspended", "suspended");
  await seedDomain("sh-suspended", "sh-suspended.shop.test", "storefront", "verified");
  await seedTenant("sh-provisioning", "provisioning");
  await seedDomain("sh-provisioning", "sh-provisioning.shop.test", "storefront", "verified");
  await seedTenant("sh-closed", "closed");
  await seedDomain("sh-closed", "sh-closed.shop.test", "storefront", "verified");
  await seedTenant("sh-pending", "active");
  await seedDomain("sh-pending", "sh-pending.shop.test", "storefront", "pending");
  await seedTenant("sh-disabled", "active");
  await seedDomain("sh-disabled", "sh-disabled.shop.test", "storefront", "disabled");
  await seedTenant("sh-otherkind", "active");
  await seedDomain("sh-otherkind", "admin.sh-otherkind.test", "admin", "verified");
  await seedDomain("sh-otherkind", "custom.sh-otherkind.test", "custom", "verified");
  await seedDomain("sh-otherkind", "preview.sh-otherkind.test", "preview", "verified");
  await seedTenant("sh-nodomain", "active");
  // A tenant whose id is not a well-formed segment: never looked up.
  await seedTenant("Sh_Upper", "active");
  await seedDomain("Sh_Upper", "sh-upper.shop.test", "storefront", "verified");
});

describe("shopStorefrontHostname", () => {
  it("answers the verified storefront hostname of an active shop", async () => {
    await expect(shopStorefrontHostname(env.DB, "sh-active")).resolves.toBe(
      "sh-active.shop.test",
    );
  });

  it("answers the lowest verified storefront hostname when there are several", async () => {
    await expect(shopStorefrontHostname(env.DB, "sh-several")).resolves.toBe(
      "aa.sh-several.test",
    );
  });

  it.each([
    ["a suspended tenant", "sh-suspended"],
    ["a provisioning tenant", "sh-provisioning"],
    ["a closed tenant", "sh-closed"],
    ["a pending domain", "sh-pending"],
    ["a disabled domain", "sh-disabled"],
    ["only domains of another kind", "sh-otherkind"],
    ["a shop with no domain", "sh-nodomain"],
    ["an unknown shop", "sh-unknown"],
  ])("answers nothing for %s", async (_label, shop) => {
    await expect(shopStorefrontHostname(env.DB, shop)).resolves.toBeNull();
  });

  it.each([
    ["an empty segment", ""],
    ["upper case", "Sh_Upper"],
    ["a leading dash", "-shop"],
    ["a dot segment", ".."],
    ["a percent-encoded segment", "sh%2Dactive"],
    ["a slash", "sh-active/x"],
    ["a space", "sh active"],
    ["64 characters", `a${"b".repeat(63)}`],
    ["a unicode letter", "sh-äctive"],
  ])("answers nothing for a malformed segment: %s", async (_label, shop) => {
    await expect(shopStorefrontHostname(env.DB, shop)).resolves.toBeNull();
  });

  it("accepts 63 characters and refuses 64", () => {
    expect(isShopSegment(`a${"b".repeat(62)}`)).toBe(true);
    expect(isShopSegment(`a${"b".repeat(63)}`)).toBe(false);
  });
});

describe("requestOnHostname", () => {
  it("moves only the host, keeping method, raw path, query, headers and body", async () => {
    const moved = requestOnHostname(
      new Request("http://web.test.invalid:8787/v1/products/%C3%A5ngra?x=%2F", {
        body: '{"a":1}',
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        method: "POST",
      }),
      "shop.example.test",
    );

    expect(moved).not.toBeNull();
    expect(moved?.url).toBe("https://shop.example.test/v1/products/%C3%A5ngra?x=%2F");
    expect(moved?.method).toBe("POST");
    expect(moved?.headers.get("authorization")).toBe("Bearer t");
    await expect(moved?.text()).resolves.toBe('{"a":1}');
  });

  it("answers null for a hostname the URL grammar does not take as given", () => {
    const request = new Request("https://web.test.invalid/v1/storefront");
    expect(requestOnHostname(request, "evil.test/path")).toBeNull();
    expect(requestOnHostname(request, "Upper.Test")).toBeNull();
    expect(requestOnHostname(request, "a.test:444")).toBeNull();
  });
});
