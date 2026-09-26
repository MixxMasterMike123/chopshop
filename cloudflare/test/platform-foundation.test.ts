import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const NOW = 1_787_000_000_000;

async function insertTenant(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
      tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
    ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, tenantId, NOW, NOW)
    .run();
}

describe("platform D1 foundation", () => {
  it("applies every foundation table", async () => {
    const result = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('tenants', 'tenant_domains', 'audit_events', 'idempotency_keys', 'outbox_events')
       ORDER BY name`,
    ).all<{ name: string }>();

    expect(result.results.map((row) => row.name)).toEqual([
      "audit_events",
      "idempotency_keys",
      "outbox_events",
      "tenant_domains",
      "tenants",
    ]);
  });

  it("enforces globally unique normalized hostnames", async () => {
    await insertTenant("tenant-host-a");
    await insertTenant("tenant-host-b");

    await env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    )
      .bind("domain-host-a", "tenant-host-a", "shop.example.test", NOW, NOW)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO tenant_domains (
          domain_id, tenant_id, hostname, kind, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'custom', 'verified', ?, ?)`,
      )
        .bind("domain-host-b", "tenant-host-b", "shop.example.test", NOW, NOW)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        `INSERT INTO tenant_domains (
          domain_id, tenant_id, hostname, kind, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'custom', 'verified', ?, ?)`,
      )
        .bind("domain-uppercase", "tenant-host-b", "SHOP.example.test", NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("blocks tenant re-homing at the database boundary", async () => {
    await insertTenant("tenant-rehome-a");
    await insertTenant("tenant-rehome-b");
    await env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    )
      .bind(
        "domain-rehome-a",
        "tenant-rehome-a",
        "tenant-a.example.test",
        NOW,
        NOW,
      )
      .run();

    await expect(
      env.DB.prepare(
        "UPDATE tenant_domains SET tenant_id = ?, updated_at = ? WHERE domain_id = ?",
      )
        .bind("tenant-rehome-b", NOW + 1, "domain-rehome-a")
        .run(),
    ).rejects.toThrow("tenant_id is immutable");
  });

  it("keeps audit history append-only", async () => {
    await insertTenant("tenant-audit");
    await env.DB.prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type, resource_id, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "audit-a",
        "tenant-audit",
        "actor-a",
        "tenant.created",
        "tenant",
        "tenant-audit",
        "request-a",
        NOW,
      )
      .run();

    await expect(
      env.DB.prepare("UPDATE audit_events SET action = ? WHERE event_id = ?")
        .bind("tenant.changed", "audit-a")
        .run(),
    ).rejects.toThrow("audit events are append-only");

    await expect(
      env.DB.prepare("DELETE FROM audit_events WHERE event_id = ?")
        .bind("audit-a")
        .run(),
    ).rejects.toThrow("audit events are append-only");
  });

  it("deduplicates idempotency and outbox effects", async () => {
    await insertTenant("tenant-dedupe");

    const insertIdempotency = () =>
      env.DB.prepare(
        `INSERT INTO idempotency_keys (
          scope, tenant_id, key_hash, operation, request_hash, state,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
      )
        .bind(
          "tenant-dedupe:checkout:key-a",
          "tenant-dedupe",
          "key-hash-a",
          "checkout.create",
          "request-hash-a",
          NOW + 60_000,
          NOW,
          NOW,
        )
        .run();

    await insertIdempotency();
    await expect(insertIdempotency()).rejects.toThrow();

    const insertOutbox = () =>
      env.DB.prepare(
        `INSERT INTO outbox_events (
          outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
          dedupe_key, payload_json, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          "tenant-dedupe",
          "tenant.created",
          "tenant",
          "tenant-dedupe",
          "tenant-created:tenant-dedupe",
          NOW,
          NOW,
          NOW,
        )
        .run();

    await insertOutbox();
    await expect(insertOutbox()).rejects.toThrow();
  });
});
