import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMapping, listMappings } from "../src/pod/pod-mappings";
import { replacePrinters } from "../src/pod/printers";
import {
  adminOf,
  CAP,
  catalogVersion,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
  hiddenPrinter,
  OPAQUE_NOT_FOUND,
  PLATFORM,
  seedArtwork,
  seedProduct,
  seedProfile,
  seedTenant,
  sessionRequest,
  signUp,
  TEE_M,
  TEE_S,
  testCapabilities,
} from "./pod-fixtures";

/**
 * CP5-WK — PATCH /v1/platform/printers/:id with `dryRun: true`: the write's
 * diff (the mappings it would suspend, the products under the floor) and the
 * revision it was computed on, with nothing written and nothing audited.
 */

const TENANT = "tenant-wk-dry";
const HOST = "https://platform.wkdry.test";
const PATH = "/v1/platform/printers/fake-printer";
const A = adminOf(TENANT);

let platform: { cookie: string; userId: string };
let tenantAdmin: { cookie: string; userId: string };

function patch(body: unknown, options: { cookie?: string; origin?: string | null; shopId?: string } = {}): Promise<Response> {
  return exports.default.fetch(
    sessionRequest(`${HOST}${PATH}`, "PATCH", {
      body,
      cookie: options.cookie ?? platform.cookie,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.shopId === undefined ? {} : { shopId: options.shopId }),
    }),
  );
}

async function revision(): Promise<number> {
  const row = await env.DB.prepare("SELECT revision FROM printers WHERE id = 'fake-printer'").first<{ revision: number }>();
  return row?.revision ?? -1;
}

/** Everything an edit could touch. */
async function snapshot(): Promise<unknown> {
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT name, status, shipping_cost_minor, capabilities_json, revision, updated_at FROM printers WHERE id = 'fake-printer'",
    ),
    env.DB.prepare(
      "SELECT sku, blank_cost_minor, print_costs_json, updated_at FROM printer_sku_tiers WHERE printer_id = 'fake-printer' ORDER BY sku",
    ),
    env.DB.prepare("SELECT id, status, suspended_reason, updated_at FROM pod_mappings ORDER BY id"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events"),
    env.DB.prepare("SELECT tenant_id, catalog_version FROM tenants ORDER BY tenant_id"),
  ]);
  return results.map((result) => result.results);
}

async function mapped(productId: string, sku: string): Promise<string> {
  await seedProduct(TENANT, { productId });
  const result = await createMapping(
    env.DB,
    A,
    { artworkId: "art-dry", printerId: "fake-printer", productId, sku, slots: ["front"], variantId: null },
    Date.now(),
  );
  expect(result.status).toBe("ok");
  return result.status === "ok" ? result.mapping.mappingId : "";
}

function withoutCap() {
  const capabilities = testCapabilities();
  delete capabilities.skus[CAP];
  delete capabilities.models.TRUCKER;
  return capabilities;
}

beforeAll(async () => {
  await seedTenant(TENANT, "wk-dry.wkdry.test");
  await seedProfile();
  await seedArtwork(TENANT, { artworkId: "art-dry" });
  platform = await signUp("wk-dry-platform@wkdry.test");
  await grantPlatformAdmin(platform.userId);
  tenantAdmin = await signUp("wk-dry-admin@wkdry.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT);
  await grantActingAs(platform.userId, TENANT);
});

beforeEach(async () => {
  expect(await replacePrinters(env.DB, PLATFORM, [hiddenPrinter()], Date.now())).not.toBeNull();
});

describe("the dry run", () => {
  it("answers the write's diff and the revision it was computed on, and writes nothing (no printer, tier, mapping, audit or catalog change)", async () => {
    const capMapping = await mapped("dry-cap", CAP);
    await mapped("dry-front", TEE_M);
    const at = await revision();
    const before = await snapshot();
    const versionBefore = await catalogVersion(TENANT);

    const response = await patch({ capabilities: withoutCap(), dryRun: true, name: "Renamed" });
    expect(response.status).toBe(200);
    const preview = await response.json<{
      diff: { fields: string[]; skus: { removed: string[] }; suspensions: Array<{ mappingId: string; reason: string }> };
      dryRun: boolean;
      printer?: unknown;
      revision: number;
      suspendedMappings: number;
    }>();
    expect(Object.keys(preview).sort()).toEqual(["diff", "dryRun", "revision", "suspendedMappings"]);
    expect(preview.dryRun).toBe(true);
    expect(preview.revision).toBe(at);
    expect(preview.suspendedMappings).toBe(1);
    expect(preview.diff.fields).toEqual(["name", "capabilities"]);
    expect(preview.diff.skus.removed).toEqual([CAP]);
    expect(preview.diff.suspensions.map(({ mappingId, reason }) => ({ mappingId, reason }))).toEqual([
      { mappingId: capMapping, reason: "sku_unavailable" },
    ]);

    expect(await snapshot()).toEqual(before);
    expect(await catalogVersion(TENANT)).toBe(versionBefore);
    const [mapping] = await listMappings(env.DB, A, "dry-cap");
    expect(mapping?.status).toBe("active");

    // The real write with the preview's revision: the same diff, now applied.
    const written = await patch({ capabilities: withoutCap(), expectedRevision: preview.revision, name: "Renamed" });
    expect(written.status).toBe(200);
    const applied = await written.json<{ diff: unknown; printer: { revision: number }; suspendedMappings: number }>();
    expect(applied.diff).toEqual(preview.diff);
    expect(applied.suspendedMappings).toBe(1);
    expect(applied.printer.revision).toBe(at + 1);
    const [suspended] = await listMappings(env.DB, A, "dry-cap");
    expect(suspended?.status).toBe("suspended");
  });

  it("the preview's revision fences the save: a printer changed in between is refused (409 revision_mismatch)", async () => {
    const preview = await (await patch({ dryRun: true, shippingCostMinor: 7_000 })).json<{ revision: number }>();
    expect((await patch({ name: "Someone else's edit" })).status).toBe(200);
    const stale = await patch({ expectedRevision: preview.revision, shippingCostMinor: 7_000 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_mismatch" } });
    // A dry run with a stale revision is refused the same way.
    const staleDry = await patch({ dryRun: true, expectedRevision: preview.revision, shippingCostMinor: 7_000 });
    expect(staleDry.status).toBe(409);
    await staleDry.body?.cancel();
  });

  it("dryRun: false is the write, as an absent flag", async () => {
    const at = await revision();
    const response = await patch({ dryRun: false, name: "Written" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ printer: { name: "Written", revision: at + 1 } });
  });

  it.each([
    ["dryRun as text", { dryRun: "true", name: "x" }],
    ["dryRun as a number", { dryRun: 1, name: "x" }],
    ["dryRun null", { dryRun: null, name: "x" }],
    ["dryRun with no edit", { dryRun: true }],
    ["dryRun with an invalid edit", { dryRun: true, status: "paused" }],
  ])("refuses %s with 400, writing nothing", async (_label, body) => {
    const before = await snapshot();
    const response = await patch(body);
    expect(response.status).toBe(400);
    await response.body?.cancel();
    expect(await snapshot()).toEqual(before);
  });

  it("an edit the write would refuse is refused the same way in a dry run", async () => {
    const response = await patch({ dryRun: true, tiers: { remove: ["0000000"] } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_tiers" } });
  });

  it("the same guard as the write: anonymous, a tenant admin, acting-as, cross-origin → the opaque 404, nothing written", async () => {
    const before = await snapshot();
    const body = { dryRun: true, name: "Peek" };
    const anonymous = await exports.default.fetch(
      new Request(`${HOST}${PATH}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", origin: HOST },
        method: "PATCH",
      }),
    );
    expect(anonymous.status).toBe(404);
    await anonymous.body?.cancel();
    for (const options of [
      { cookie: tenantAdmin.cookie, shopId: TENANT },
      { cookie: tenantAdmin.cookie },
      { shopId: TENANT },
      { origin: "https://evil.test" },
      { origin: null },
    ]) {
      const response = await patch(body, options);
      expect(response.status, JSON.stringify(options)).toBe(404);
      expect(await response.json()).toEqual(OPAQUE_NOT_FOUND);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("the floor report of a dry run is the write's (raising a tier)", async () => {
    await mapped("dry-floor", TEE_S);
    const raise = {
      tiers: { upsert: [{ blankCostMinor: 70_000, printCostsMinor: { back: 6_223, front: 6_211, pocket: 6_039 }, sku: TEE_S }] },
    };
    const preview = await (await patch({ ...raise, dryRun: true })).json<{ diff: { belowFloor: unknown } }>();
    const written = await (await patch(raise)).json<{ diff: { belowFloor: unknown } }>();
    expect(preview.diff.belowFloor).toEqual(written.diff.belowFloor);
  });
});
