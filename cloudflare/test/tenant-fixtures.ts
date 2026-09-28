import { env } from "cloudflare:workers";
import { expect } from "vitest";

import {
  bootstrapPlatform,
  call,
  type CallOptions,
  createTenant,
  expectJson,
  PLATFORM,
  SLICE_PICKUP_LOCATION,
  SliceWorld,
  type Tenant,
} from "./slice-harness";

/**
 * CP3-A test fixtures (tenant directory, features, domains, store settings).
 * Not a test file. Built on the CP2 slice harness, so every tenant, admin and
 * session here comes from the real routes (POST /v1/platform/bootstrap,
 * /v1/platform/tenants, /v1/platform/users, …/admins, Better Auth sign-in).
 */

export { expectJson, PLATFORM, SliceWorld, type Tenant };

/** The three kinds of caller every CP3-A route is checked against. */
export type Caller = "anonymous" | "platform" | "tenantAdmin";
export const CALLERS: readonly Caller[] = ["anonymous", "tenantAdmin", "platform"];

/** One bootstrapped platform and `count` shops, each with its own signed-in admin. */
export async function tenantWorld(
  prefix: string,
  count: number,
): Promise<{ tenants: Tenant[]; world: SliceWorld }> {
  const world = new SliceWorld();
  await bootstrapPlatform(world);
  const tenants: Tenant[] = [];
  for (let index = 0; index < count; index += 1) {
    const tenantId = `${prefix}-${String.fromCharCode(97 + index)}`;
    tenants.push(
      await createTenant(world, {
        host: `${tenantId}.shops.cp3a.test`,
        // These suites are about a shop's configuration: start unconfigured.
        legallyReady: false,
        shopName: `Butik ${tenantId}`,
        tenantId,
      }),
    );
  }
  return { tenants, world };
}

/**
 * A request as `who` to a path on the platform host. The tenant admin sends
 * its own shop in X-Shop-Id (what a tenant-admin client always does), which a
 * platform route must ignore.
 */
export function callAs(
  world: SliceWorld,
  who: Caller,
  tenant: Tenant,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const identity: CallOptions =
    who === "platform"
      ? { cookie: world.platformCookie }
      : who === "tenantAdmin"
        ? { cookie: tenant.adminCookie, shopId: tenant.tenantId }
        : {};
  return call(world, method, `${PLATFORM}${path}`, { ...identity, ...options });
}

export function platform(
  world: SliceWorld,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  return call(world, method, `${PLATFORM}${path}`, { cookie: world.platformCookie, ...options });
}

/** The one opaque 404 every guarded surface answers with. */
export async function expectOpaque404(response: Response, label: string): Promise<void> {
  const body = await expectJson(response, 404, label);
  expect(body, label).toEqual({ error: { code: "not_found", message: "Route not found" } });
}

export interface AuditRowView {
  action: string;
  actorUserId: string | null;
  metadata: Record<string, unknown> | null;
  reason: string | null;
  resourceId: string | null;
  resourceType: string;
  tenantId: string | null;
}

export async function auditRows(tenantId: string, action?: string): Promise<AuditRowView[]> {
  const rows = await env.DB.prepare(
    `SELECT tenant_id, actor_user_id, action, resource_type, resource_id, reason, metadata_json
     FROM audit_events
     WHERE tenant_id = ? AND (? IS NULL OR action = ?)
     ORDER BY created_at, rowid`,
  )
    .bind(tenantId, action ?? null, action ?? null)
    .all<{
      action: string;
      actor_user_id: string | null;
      metadata_json: string | null;
      reason: string | null;
      resource_id: string | null;
      resource_type: string;
      tenant_id: string | null;
    }>();
  return rows.results.map((row) => ({
    action: row.action,
    actorUserId: row.actor_user_id,
    metadata: row.metadata_json === null ? null : (JSON.parse(row.metadata_json) as Record<string, unknown>),
    reason: row.reason,
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    tenantId: row.tenant_id,
  }));
}

export async function auditCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function tenantRow(tenantId: string) {
  return env.DB.prepare(
    `SELECT tenant_id, status, published, catalog_version, shop_name, support_email,
            vat_rate_bp, commission_bps
     FROM tenants WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<{
      catalog_version: number;
      commission_bps: number | null;
      published: number;
      shop_name: string | null;
      status: string;
      support_email: string | null;
      tenant_id: string;
      vat_rate_bp: number;
    }>();
}

export async function domainByHostname(hostname: string) {
  return env.DB.prepare(
    "SELECT domain_id, tenant_id, hostname, kind, status, verified_at FROM tenant_domains WHERE hostname = ?",
  )
    .bind(hostname)
    .first<{
      domain_id: string;
      hostname: string;
      kind: string;
      status: string;
      tenant_id: string;
      verified_at: number | null;
    }>();
}

/** A fresh shop with no admin (for close / move-target cases), via the real create route. */
export async function bareTenant(world: SliceWorld, tenantId: string): Promise<string> {
  await expectJson(
    await platform(world, "POST", "/v1/platform/tenants", {
      body: { hostname: `${tenantId}.shops.cp3a.test`, shopName: `Butik ${tenantId}`, tenantId },
    }),
    201,
    `create ${tenantId}`,
  );
  return `${tenantId}.shops.cp3a.test`;
}

/**
 * Opens the CP3-E legal-readiness checkout gate through the real routes, as
 * the shop's own admin: the return address and the VAT answer (PUT
 * /v1/admin/settings, this builder's route) and the adoption of the three
 * consumer pages (POST /v1/admin/legal/accept-pages). The page texts are
 * invented test copy.
 */
export async function makeLegallyReady(world: SliceWorld, tenant: Tenant): Promise<void> {
  const admin = { cookie: tenant.adminCookie, shopId: tenant.tenantId };
  await expectJson(
    await call(world, "PUT", "https://admin.slice.test/v1/admin/settings", {
      ...admin,
      body: {
        returnAddress: "Returgatan 1, 123 45 Teststad",
        // D98: the pickup place the slice harness's default recipient names.
        storeIdentity: { pickupLocations: [SLICE_PICKUP_LOCATION] },
        vatRegistered: true,
      },
    }),
    200,
    `settings for ${tenant.tenantId}`,
  );
  await expectJson(
    await call(world, "POST", "https://admin.slice.test/v1/admin/legal/accept-pages", {
      ...admin,
      body: {
        custom: false,
        pod: false,
        templateVersion: "2026-09-07",
        texts: {
          angerratt: "<p>Ångerrätt 14 dagar</p>",
          integritetspolicy: "<p>Personuppgifter</p>",
          kopvillkor: "<h2>Köpvillkor</h2>",
        },
      },
    }),
    201,
    `legal pages for ${tenant.tenantId}`,
  );
}

/** GET /v1/storefront on `host`: the shop name, or null when the host does not resolve. */
export async function storefrontName(world: SliceWorld, host: string): Promise<string | null> {
  const response = await call(world, "GET", `https://${host}/v1/storefront`);
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  const body = await response.json<{ storefront: { name: string } }>();
  return body.storefront.name;
}
