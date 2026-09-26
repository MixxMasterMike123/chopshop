import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  authorizePlatformAdmin,
  authorizePrintOperator,
  authorizeTenantAdmin,
} from "../src/auth/live-authorization";
import { resolveRequestTenant } from "../src/tenancy/resolve-tenant";

const NOW = 1_787_000_000_000;

async function seedTenant(
  tenantId: string,
  hostname: string,
  status = "active",
  domainStatus = "verified",
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
      ) VALUES (?, ?, ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, status, tenantId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', ?, ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, domainStatus, NOW, NOW),
  ]);
}

async function seedIdentity(
  userId: string,
  accountType: string,
  accessStatus = "active",
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.test`, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO identity_access (
        user_id, account_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, accountType, accessStatus, NOW, NOW),
  ]);
}

describe("tenant resolution", () => {
  it("derives the tenant only from a verified active request hostname", async () => {
    await seedTenant("tenant-resolve", "shop.resolve.test");

    const request = new Request("https://SHOP.RESOLVE.TEST/products", {
      headers: {
        "x-shop-id": "attacker-selected-tenant",
        "x-forwarded-host": "attacker.example.test",
      },
    });

    await expect(resolveRequestTenant(env.DB, request)).resolves.toEqual({
      domainKind: "storefront",
      hostname: "shop.resolve.test",
      tenantId: "tenant-resolve",
    });
  });

  it("fails closed for unknown, unverified, and inactive tenant hosts", async () => {
    await seedTenant(
      "tenant-pending-domain",
      "pending.resolve.test",
      "active",
      "pending",
    );
    await seedTenant(
      "tenant-suspended",
      "suspended.resolve.test",
      "suspended",
    );

    await expect(
      resolveRequestTenant(
        env.DB,
        new Request("https://unknown.resolve.test/products"),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveRequestTenant(
        env.DB,
        new Request("https://pending.resolve.test/products"),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveRequestTenant(
        env.DB,
        new Request("https://suspended.resolve.test/products"),
      ),
    ).resolves.toBeNull();
  });
});

describe("live authorization", () => {
  it("does not let a tenant admin cross the tenant boundary", async () => {
    await seedTenant("tenant-guard-a", "a.guard.test");
    await seedTenant("tenant-guard-b", "b.guard.test");
    await seedIdentity("admin-guard-a", "tenant_admin");
    await env.DB.prepare(
      `INSERT INTO tenant_memberships (
        membership_id, tenant_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    )
      .bind(
        "membership-guard-a",
        "tenant-guard-a",
        "admin-guard-a",
        NOW,
        NOW,
      )
      .run();

    await expect(
      authorizeTenantAdmin(env.DB, "admin-guard-a", "tenant-guard-a"),
    ).resolves.toEqual({
      accountType: "tenant_admin",
      role: "admin",
      tenantId: "tenant-guard-a",
      userId: "admin-guard-a",
    });
    await expect(
      authorizeTenantAdmin(env.DB, "admin-guard-a", "tenant-guard-b"),
    ).resolves.toBeNull();
  });

  it("revokes tenant access immediately when live records change", async () => {
    await seedTenant("tenant-live-guard", "live.guard.test");
    await seedIdentity("admin-live-guard", "tenant_admin");
    await env.DB.prepare(
      `INSERT INTO tenant_memberships (
        membership_id, tenant_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    )
      .bind(
        "membership-live-guard",
        "tenant-live-guard",
        "admin-live-guard",
        NOW,
        NOW,
      )
      .run();

    expect(
      await authorizeTenantAdmin(
        env.DB,
        "admin-live-guard",
        "tenant-live-guard",
      ),
    ).not.toBeNull();

    await env.DB.prepare(
      "UPDATE identity_access SET status = 'revoked', updated_at = ? WHERE user_id = ?",
    )
      .bind(NOW + 1, "admin-live-guard")
      .run();

    await expect(
      authorizeTenantAdmin(
        env.DB,
        "admin-live-guard",
        "tenant-live-guard",
      ),
    ).resolves.toBeNull();
  });

  it("requires both print account kind and an active tenant assignment", async () => {
    await seedTenant("tenant-print-guard-a", "a.print.guard.test");
    await seedTenant("tenant-print-guard-b", "b.print.guard.test");
    await seedIdentity("operator-print-guard", "print_operator");
    await env.DB.prepare(
      `INSERT INTO print_memberships (
        membership_id, tenant_id, user_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?)`,
    )
      .bind(
        "print-membership-guard",
        "tenant-print-guard-a",
        "operator-print-guard",
        NOW,
        NOW,
      )
      .run();

    await expect(
      authorizePrintOperator(
        env.DB,
        "operator-print-guard",
        "tenant-print-guard-a",
      ),
    ).resolves.toEqual({
      accountType: "print_operator",
      tenantId: "tenant-print-guard-a",
      userId: "operator-print-guard",
    });
    await expect(
      authorizePrintOperator(
        env.DB,
        "operator-print-guard",
        "tenant-print-guard-b",
      ),
    ).resolves.toBeNull();
  });

  it("recognizes only a live platform-admin record", async () => {
    await seedIdentity("platform-guard", "platform_admin");
    await seedIdentity("ordinary-guard", "ordinary");

    await expect(
      authorizePlatformAdmin(env.DB, "platform-guard"),
    ).resolves.toEqual({
      accountType: "platform_admin",
      userId: "platform-guard",
    });
    await expect(
      authorizePlatformAdmin(env.DB, "ordinary-guard"),
    ).resolves.toBeNull();
    await expect(
      authorizePlatformAdmin(env.DB, "missing-guard"),
    ).resolves.toBeNull();
  });
});
