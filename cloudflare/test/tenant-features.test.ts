import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DELETED_FEATURE_KEYS,
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  isFeatureEnabled,
  NOT_PORTED_FEATURE_KEYS,
} from "../src/platform/tenant-config";
import {
  auditCount,
  auditRows,
  bareTenant,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP3-A — per-shop add-on flags (0032 tenant_features, src/platform/
 * tenant-config.ts). D22: effective values are stored; two groups of Firebase
 * keys are refused — DELETED from the product (the four CRM add-ons) and NOT
 * PORTED YET (affiliate, b2b). The authorization matrix for the two routes is
 * in platform-tenants.test.ts.
 */

/** Both refused groups, named apart as in the code. */
const REFUSED_KEYS: Array<[group: string, key: string]> = [
  ...DELETED_FEATURE_KEYS.map((key): [string, string] => ["deleted from the product", key]),
  ...NOT_PORTED_FEATURE_KEYS.map((key): [string, string] => ["not ported yet", key]),
];

interface FeaturesBody {
  features: Array<{ defaultEnabled: boolean; enabled: boolean; key: string; source: string }>;
  tenantId: string;
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;

const EXPECTED_DEFAULTS = {
  // CP9-AC (AC2): opt-in.
  abandonedCheckout: false,
  contentStudio: false,
  // CP8-DC (DC2): opt-in.
  discountCodes: false,
  marketingMaterials: false,
  pod: false,
  productReviews: true,
};

async function readFeatures(tenantId: string): Promise<FeaturesBody> {
  return expectJson<FeaturesBody>(
    await platform(world, "GET", `/v1/platform/tenants/${tenantId}/features`),
    200,
    `features of ${tenantId}`,
  );
}

async function featureRowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tenant_features").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  const setup = await tenantWorld("tf", 2);
  world = setup.world;
  [shopA, shopB] = setup.tenants as [Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the allowlist", () => {
  it("is the add-on catalogue minus both refused groups, with Firebase's defaults", () => {
    expect([...FEATURE_KEYS]).toEqual(Object.keys(EXPECTED_DEFAULTS));
    expect(FEATURE_DEFAULTS).toEqual(EXPECTED_DEFAULTS);
    expect([...DELETED_FEATURE_KEYS]).toEqual(["ambassador", "campaigns", "dining", "writers"]);
    expect([...NOT_PORTED_FEATURE_KEYS]).toEqual(["affiliate", "b2b"]);
    for (const [group, key] of REFUSED_KEYS) {
      expect(FEATURE_KEYS as readonly string[], `${key} (${group})`).not.toContain(key);
    }
  });

  it("equals the key list the 0032 triggers enforce", async () => {
    const rows = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND name IN (
         'tenant_features_key_allowlist_insert', 'tenant_features_key_allowlist_update'
       )
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      const list = /NOT IN \(([^)]*)\)/.exec(row.sql)?.[1] ?? "";
      const keys = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(keys.sort(), row.name).toEqual([...FEATURE_KEYS].sort());
    }
  });

  it("the database itself refuses an unknown, a deleted or a not-ported key", async () => {
    for (const key of ["notAFeature", ...REFUSED_KEYS.map(([, refused]) => refused)]) {
      await expect(
        env.DB.prepare(
          `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
           VALUES (?, ?, 1, '2026-09-27T00:00:00.000Z', 'test')`,
        )
          .bind(shopA.tenantId, key)
          .run(),
        key,
      ).rejects.toThrow(/not an allowed feature/);
    }
    await env.DB.prepare(
      `INSERT INTO tenant_features (tenant_id, feature_key, enabled, updated_at, updated_by)
       VALUES (?, 'productReviews', 1, '2026-09-27T00:00:00.000Z', 'test')`,
    )
      .bind(shopB.tenantId)
      .run();
    for (const key of ["dining", "affiliate"]) {
      await expect(
        env.DB.prepare("UPDATE tenant_features SET feature_key = ? WHERE tenant_id = ?")
          .bind(key, shopB.tenantId)
          .run(),
        key,
      ).rejects.toThrow(/not an allowed feature/);
    }
    await expect(
      env.DB.prepare("UPDATE tenant_features SET tenant_id = ? WHERE tenant_id = ?")
        .bind(shopA.tenantId, shopB.tenantId)
        .run(),
    ).rejects.toThrow(/tenant_id is immutable/);
    await env.DB.prepare("DELETE FROM tenant_features WHERE tenant_id = ?").bind(shopB.tenantId).run();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/platform/tenants/:tenantId/features", () => {
  it("answers every allowed key with its default when nothing is explicit", async () => {
    const body = await readFeatures(shopA.tenantId);
    expect(body.tenantId).toBe(shopA.tenantId);
    expect(body.features).toEqual(
      FEATURE_KEYS.map((key) => ({
        defaultEnabled: EXPECTED_DEFAULTS[key],
        enabled: EXPECTED_DEFAULTS[key],
        key,
        source: "default",
      })),
    );
  });

  it("answers the opaque 404 for an unknown tenant", async () => {
    await expectOpaque404(await platform(world, "GET", "/v1/platform/tenants/tf-nobody/features"), "unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PUT /v1/platform/tenants/:tenantId/features", () => {
  it("honours an explicit OFF on a default-on key and an explicit ON on an opt-in key", async () => {
    const body = await expectJson<FeaturesBody>(
      await platform(world, "PUT", `/v1/platform/tenants/${shopA.tenantId}/features`, {
        body: { features: { pod: true, productReviews: false } },
      }),
      200,
      "put",
    );
    const byKey = new Map(body.features.map((feature) => [feature.key, feature]));
    // CP9-AC moved this example to productReviews, the one default-ON key left.
    expect(byKey.get("productReviews")).toEqual({
      defaultEnabled: true,
      enabled: false,
      key: "productReviews",
      source: "explicit",
    });
    expect(byKey.get("pod")).toEqual({ defaultEnabled: false, enabled: true, key: "pod", source: "explicit" });
    // Keys not named keep their default.
    expect(byKey.get("abandonedCheckout")).toMatchObject({ enabled: false, source: "default" });
    expect(await readFeatures(shopA.tenantId)).toEqual(body);

    // The shared predicate agrees with the route.
    await expect(isFeatureEnabled(env.DB, shopA.tenantId, "productReviews")).resolves.toBe(false);
    await expect(isFeatureEnabled(env.DB, shopA.tenantId, "pod")).resolves.toBe(true);
    await expect(isFeatureEnabled(env.DB, shopA.tenantId, "abandonedCheckout")).resolves.toBe(false);
    await expect(isFeatureEnabled(env.DB, shopA.tenantId, "contentStudio")).resolves.toBe(false);
    // Another tenant is untouched.
    await expect(isFeatureEnabled(env.DB, shopB.tenantId, "productReviews")).resolves.toBe(true);
    await expect(isFeatureEnabled(env.DB, shopB.tenantId, "pod")).resolves.toBe(false);

    const [audit] = await auditRows(shopA.tenantId, "tenant.features_update");
    expect(audit).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: {
        previous: {
          pod: { enabled: false, source: "default" },
          productReviews: { enabled: true, source: "default" },
        },
        set: { pod: true, productReviews: false },
      },
      resourceId: shopA.tenantId,
      resourceType: "tenant",
    });
  });

  it("an explicit value equal to the default is still stored as explicit (D22: effective values)", async () => {
    const body = await expectJson<FeaturesBody>(
      await platform(world, "PUT", `/v1/platform/tenants/${shopA.tenantId}/features`, {
        body: { features: { abandonedCheckout: true, productReviews: true } },
      }),
      200,
      "put",
    );
    const byKey = new Map(body.features.map((feature) => [feature.key, feature]));
    expect(byKey.get("productReviews")).toMatchObject({ enabled: true, source: "explicit" });
    // CP9-AC: an explicit ON of the opt-in key.
    expect(byKey.get("abandonedCheckout")).toMatchObject({ enabled: true, source: "explicit" });
    expect(byKey.get("pod")).toMatchObject({ enabled: true, source: "explicit" });
  });

  it.each([
    ["an unknown key", { features: { notAFeature: true } }],
    ["a deleted CRM key (dining)", { features: { dining: false } }],
    ["a deleted CRM key (writers)", { features: { writers: true } }],
    ["a deleted CRM key (campaigns)", { features: { campaigns: true } }],
    ["a deleted CRM key (ambassador)", { features: { ambassador: true } }],
    ["a not-ported key (affiliate)", { features: { affiliate: true } }],
    ["a not-ported key (b2b)", { features: { b2b: false } }],
    ["a valid key beside a deleted one", { features: { pod: false, dining: true } }],
    ["a valid key beside a not-ported one", { features: { discountCodes: false, affiliate: true } }],
    ["a non-boolean value", { features: { pod: "true" } }],
    ["a null value", { features: { pod: null } }],
    ["an empty map", { features: {} }],
    ["an array", { features: [] }],
    ["a missing map", {}],
    ["an unknown top-level key", { features: { pod: false }, tenantId: "tf-b" }],
  ])("refuses %s and writes nothing", async (_label, body) => {
    const rows = await featureRowCount();
    const audits = await auditCount();
    await expectJson(
      await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/features`, { body }),
      400,
      "invalid",
    );
    expect(await featureRowCount()).toBe(rows);
    expect(await auditCount()).toBe(audits);
  });

  it("answers the opaque 404 for an unknown tenant and 409 for a closed one", async () => {
    await expectOpaque404(
      await platform(world, "PUT", "/v1/platform/tenants/tf-nobody/features", { body: { features: { pod: true } } }),
      "unknown",
    );
    await bareTenant(world, "tf-closed");
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/tf-closed/close"), 200, "close");
    await expectJson(
      await platform(world, "PUT", "/v1/platform/tenants/tf-closed/features", { body: { features: { pod: true } } }),
      409,
      "closed",
    );
    await expect(isFeatureEnabled(env.DB, "tf-closed", "pod")).resolves.toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("isFeatureEnabled", () => {
  it("applies the default rule for a tenant with no rows and never enables an unknown key", async () => {
    for (const key of FEATURE_KEYS) {
      await expect(isFeatureEnabled(env.DB, shopB.tenantId, key), key).resolves.toBe(EXPECTED_DEFAULTS[key]);
    }
    // A refused key is never enabled — including the two that Firebase treated
    // as default-ON (affiliate, b2b).
    for (const [group, key] of REFUSED_KEYS) {
      await expect(
        isFeatureEnabled(env.DB, shopB.tenantId, key as unknown as (typeof FEATURE_KEYS)[number]),
        `${key} (${group})`,
      ).resolves.toBe(false);
    }
  });
});
