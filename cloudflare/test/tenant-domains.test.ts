import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveRequestTenant } from "../src/tenancy/resolve-tenant";
import { settle } from "./slice-harness";
import {
  auditCount,
  auditRows,
  bareTenant,
  domainByHostname,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  storefrontName,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP3-A — hostname operations (src/platform/tenant-domains.ts): list, lookup,
 * disable / enable, delete, move. The authorization matrix for these routes is
 * in platform-tenants.test.ts (every CP3-A platform route in one table).
 */

interface DomainBody {
  createdAt: string;
  domainId: string;
  hostname: string;
  kind: string;
  status: string;
  updatedAt: string;
  verifiedAt: string | null;
}

interface LookupBody {
  domain: (DomainBody & { resolves: boolean; tenantId: string; tenantStatus: string }) | null;
}

interface MoveBody {
  domain: DomainBody;
  fromTenantId: string;
  moved: boolean;
  toTenantId: string;
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;

async function addDomain(tenantId: string, hostname: string, kind = "storefront"): Promise<string> {
  const body = await expectJson<{ domain: { domainId: string } }>(
    await platform(world, "POST", `/v1/platform/tenants/${tenantId}/domains`, { body: { hostname, kind } }),
    201,
    `add ${hostname}`,
  );
  return body.domain.domainId;
}

async function resolvesTo(hostname: string): Promise<string | null> {
  return (await resolveRequestTenant(env.DB, new Request(`https://${hostname}/v1/storefront`)))?.tenantId ?? null;
}

beforeAll(async () => {
  const setup = await tenantWorld("td", 2);
  world = setup.world;
  [shopA, shopB] = setup.tenants as [Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/platform/tenants/:tenantId/domains", () => {
  it("lists a tenant's domains by hostname, paged by a hostname cursor", async () => {
    await addDomain(shopA.tenantId, "b.list.td.test");
    await addDomain(shopA.tenantId, "a.list.td.test", "admin");

    const all = await expectJson<{ domains: DomainBody[]; nextCursor: string | null; tenantId: string }>(
      await platform(world, "GET", `/v1/platform/tenants/${shopA.tenantId}/domains`),
      200,
      "list",
    );
    expect(all.tenantId).toBe(shopA.tenantId);
    expect(all.nextCursor).toBeNull();
    expect(all.domains.map((domain) => domain.hostname)).toEqual([
      "a.list.td.test",
      "b.list.td.test",
      shopA.host,
    ]);
    expect(all.domains[0]).toEqual({
      createdAt: expect.any(String),
      domainId: expect.any(String),
      hostname: "a.list.td.test",
      kind: "admin",
      status: "verified",
      updatedAt: expect.any(String),
      verifiedAt: expect.any(String),
    });

    const first = await expectJson<{ domains: DomainBody[]; nextCursor: string | null }>(
      await platform(world, "GET", `/v1/platform/tenants/${shopA.tenantId}/domains?limit=2`),
      200,
      "page 1",
    );
    expect(first.domains.map((domain) => domain.hostname)).toEqual(["a.list.td.test", "b.list.td.test"]);
    expect(first.nextCursor).toBe("b.list.td.test");
    const second = await expectJson<{ domains: DomainBody[]; nextCursor: string | null }>(
      await platform(world, "GET", `/v1/platform/tenants/${shopA.tenantId}/domains?limit=2&cursor=b.list.td.test`),
      200,
      "page 2",
    );
    expect(second.domains.map((domain) => domain.hostname)).toEqual([shopA.host]);
    expect(second.nextCursor).toBeNull();
  });

  it("answers the opaque 404 for an unknown tenant and 400 for a bad query", async () => {
    await expectOpaque404(await platform(world, "GET", "/v1/platform/tenants/td-nobody/domains"), "unknown");
    for (const query of ["limit=0", "limit=101", "cursor=bad..host", "hostname=x"]) {
      await expectJson(
        await platform(world, "GET", `/v1/platform/tenants/${shopA.tenantId}/domains?${query}`),
        400,
        query,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/platform/domains/lookup — who holds a hostname", () => {
  it("answers the holder, normalising case and the trailing dot", async () => {
    const body = await expectJson<LookupBody>(
      await platform(world, "GET", `/v1/platform/domains/lookup?hostname=${shopB.host.toUpperCase()}.`),
      200,
      "lookup",
    );
    expect(body.domain).toMatchObject({
      hostname: shopB.host,
      kind: "storefront",
      resolves: true,
      status: "verified",
      tenantId: shopB.tenantId,
      tenantStatus: "active",
    });
  });

  it("answers { domain: null } when nobody holds it", async () => {
    const body = await expectJson<LookupBody>(
      await platform(world, "GET", "/v1/platform/domains/lookup?hostname=nobody.td.test"),
      200,
      "lookup",
    );
    expect(body).toEqual({ domain: null });
  });

  it.each([
    ["no hostname", ""],
    ["a malformed hostname", "?hostname=bad..host"],
    ["a port", "?hostname=shop.td.test:8080"],
    ["an extra parameter", "?hostname=nobody.td.test&tenantId=td-a"],
    ["the hostname twice", "?hostname=a.td.test&hostname=b.td.test"],
  ])("refuses %s", async (_label, query) => {
    await expectJson(await platform(world, "GET", `/v1/platform/domains/lookup${query}`), 400, query);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("disable / enable", () => {
  it("a disabled hostname stops resolving on the next request; enable restores it", async () => {
    const hostname = "toggle.td.test";
    const domainId = await addDomain(shopB.tenantId, hostname);
    expect(await storefrontName(world, hostname)).toBe(shopB.shopName);

    const disabled = await expectJson<{ domain: DomainBody; tenantId: string }>(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/disable`),
      200,
      "disable",
    );
    expect(disabled.domain.status).toBe("disabled");
    // resolve-tenant.ts serves only `verified` rows — proven through the real
    // storefront route and the resolver itself.
    expect(await storefrontName(world, hostname)).toBeNull();
    expect(await resolvesTo(hostname)).toBeNull();
    const lookup = await expectJson<LookupBody>(
      await platform(world, "GET", `/v1/platform/domains/lookup?hostname=${hostname}`),
      200,
      "lookup while disabled",
    );
    expect(lookup.domain).toMatchObject({ resolves: false, status: "disabled", tenantId: shopB.tenantId });

    const enabled = await expectJson<{ domain: DomainBody }>(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/enable`),
      200,
      "enable",
    );
    expect(enabled.domain.status).toBe("verified");
    expect(await storefrontName(world, hostname)).toBe(shopB.shopName);

    const audits = await auditRows(shopB.tenantId);
    expect(
      audits.filter((row) => row.resourceId === domainId).map((row) => [row.action, row.metadata]),
    ).toEqual([
      ["tenant.domain_add", { hostname }],
      ["tenant.domain_disable", { from: "verified", hostname, to: "disabled" }],
      ["tenant.domain_enable", { from: "disabled", hostname, to: "verified" }],
    ]);
  });

  it("repeating either action answers 200 and writes nothing", async () => {
    const domainId = await addDomain(shopB.tenantId, "repeat.td.test");
    const before = await auditCount();
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/enable`),
      200,
      "enable an enabled domain",
    );
    expect(await auditCount()).toBe(before);

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/disable`),
      200,
      "disable",
    );
    const afterFirst = await auditCount();
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/disable`),
      200,
      "disable again",
    );
    expect(await auditCount()).toBe(afterFirst);
  });

  it("a domain never verified is enabled back to pending, not verified", async () => {
    const domainId = await addDomain(shopB.tenantId, "pending.td.test");
    await env.DB.prepare(
      "UPDATE tenant_domains SET status = 'disabled', verified_at = NULL WHERE domain_id = ?",
    )
      .bind(domainId)
      .run();
    const enabled = await expectJson<{ domain: DomainBody }>(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/enable`),
      200,
      "enable",
    );
    expect(enabled.domain).toMatchObject({ status: "pending", verifiedAt: null });
    expect(await resolvesTo("pending.td.test")).toBeNull();
  });

  it("nothing turns back on in a closed shop, but its domains can still be disabled", async () => {
    const host = await bareTenant(world, "td-closed-toggle");
    const domainId = (await domainByHostname(host))?.domain_id as string;
    const spare = await addDomain("td-closed-toggle", "spare.closed.td.test");
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/td-closed-toggle/domains/${spare}/disable`),
      200,
      "disable before close",
    );
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/td-closed-toggle/close"), 200, "close");

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/td-closed-toggle/domains/${domainId}/disable`),
      200,
      "disable in a closed shop",
    );
    const refused = await expectJson<{ error: { code: string } }>(
      await platform(world, "POST", `/v1/platform/tenants/td-closed-toggle/domains/${spare}/enable`),
      409,
      "enable in a closed shop",
    );
    expect(refused.error.code).toBe("conflict");
    expect((await domainByHostname("spare.closed.td.test"))?.status).toBe("disabled");
  });

  it("a domain is addressed only under its own tenant", async () => {
    const domainId = (await domainByHostname(shopA.host))?.domain_id as string;
    await expectOpaque404(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}/disable`),
      "another tenant's domain",
    );
    expect((await domainByHostname(shopA.host))?.status).toBe("verified");
    await expectOpaque404(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/no-such-domain/disable`),
      "unknown domain",
    );
    await expectOpaque404(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains/bad%2Fid/disable`),
      "an id with a slash",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("DELETE /v1/platform/tenants/:tenantId/domains/:domainId", () => {
  it("deletes the row, audited, and the hostname stops resolving", async () => {
    const domainId = await addDomain(shopB.tenantId, "delete.td.test");
    const response = await platform(world, "DELETE", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}`);
    expect(response.status).toBe(204);
    expect(await domainByHostname("delete.td.test")).toBeNull();
    expect(await storefrontName(world, "delete.td.test")).toBeNull();

    const [audit] = await auditRows(shopB.tenantId, "tenant.domain_delete");
    expect(audit).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { hostname: "delete.td.test", kind: "storefront", status: "verified" },
      resourceId: domainId,
      resourceType: "tenant_domain",
    });
  });

  it("answers the opaque 404 for an unknown id or another tenant's domain, deleting nothing", async () => {
    const domainId = (await domainByHostname(shopA.host))?.domain_id as string;
    const before = await auditCount();
    await expectOpaque404(
      await platform(world, "DELETE", `/v1/platform/tenants/${shopB.tenantId}/domains/${domainId}`),
      "another tenant's",
    );
    await expectOpaque404(
      await platform(world, "DELETE", `/v1/platform/tenants/${shopB.tenantId}/domains/nope`),
      "unknown",
    );
    expect(await domainByHostname(shopA.host)).not.toBeNull();
    expect(await auditCount()).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /v1/platform/domains/move", () => {
  it("moves a hostname to another tenant in one audited batch; it resolves there next request", async () => {
    const hostname = "moving.td.test";
    const oldId = await addDomain(shopA.tenantId, hostname);
    expect(await storefrontName(world, hostname)).toBe(shopA.shopName);

    const body = await expectJson<MoveBody>(
      await platform(world, "POST", "/v1/platform/domains/move", {
        body: { hostname: "Moving.TD.test.", toTenantId: shopB.tenantId },
      }),
      200,
      "move",
    );
    expect(body).toMatchObject({
      domain: { hostname, kind: "storefront", status: "verified" },
      fromTenantId: shopA.tenantId,
      moved: true,
      toTenantId: shopB.tenantId,
    });
    expect(body.domain.domainId).not.toBe(oldId);
    expect(body.domain.verifiedAt).not.toBeNull();

    expect(await domainByHostname(hostname)).toMatchObject({ domain_id: body.domain.domainId, tenant_id: shopB.tenantId });
    expect(await storefrontName(world, hostname)).toBe(shopB.shopName);

    const expected = {
      fromDomainId: oldId,
      fromTenantId: shopA.tenantId,
      hostname,
      kind: "storefront",
      status: "verified",
      toDomainId: body.domain.domainId,
      toTenantId: shopB.tenantId,
    };
    expect(await auditRows(shopA.tenantId, "tenant.domain_move_out")).toEqual([
      expect.objectContaining({ actorUserId: world.platformUserId, metadata: expected, resourceId: oldId }),
    ]);
    expect(await auditRows(shopB.tenantId, "tenant.domain_move_in")).toEqual([
      expect.objectContaining({
        actorUserId: world.platformUserId,
        metadata: expected,
        resourceId: body.domain.domainId,
      }),
    ]);
  });

  it("carries the domain's status: a disabled hostname stays disabled on its new tenant", async () => {
    const hostname = "moving-disabled.td.test";
    const domainId = await addDomain(shopA.tenantId, hostname);
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/domains/${domainId}/disable`),
      200,
      "disable",
    );
    const body = await expectJson<MoveBody>(
      await platform(world, "POST", "/v1/platform/domains/move", { body: { hostname, toTenantId: shopB.tenantId } }),
      200,
      "move",
    );
    expect(body.domain.status).toBe("disabled");
    expect(await resolvesTo(hostname)).toBeNull();
  });

  it("is atomic: when the INSERT fails, the DELETE is rolled back and nothing is audited", async () => {
    const hostname = "atomic.td.test";
    const oldId = await addDomain(shopA.tenantId, hostname);
    const before = await auditCount();

    // A test-only trigger makes the move's INSERT (and only it) fail inside the
    // batch, AFTER the DELETE statement has run.
    await env.DB.prepare(
      `CREATE TRIGGER td_test_refuse_move BEFORE INSERT ON tenant_domains
       WHEN NEW.hostname = 'atomic.td.test'
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    ).run();
    try {
      expect(
        await settle(
          platform(world, "POST", "/v1/platform/domains/move", { body: { hostname, toTenantId: shopB.tenantId } }),
        ),
      ).toBe("threw");
    } finally {
      await env.DB.prepare("DROP TRIGGER td_test_refuse_move").run();
    }

    expect(await domainByHostname(hostname)).toMatchObject({ domain_id: oldId, tenant_id: shopA.tenantId });
    expect(await auditCount()).toBe(before);
    expect(await resolvesTo(hostname)).toBe(shopA.tenantId);
  });

  it("answers 409 when no tenant holds the hostname", async () => {
    const body = await expectJson<{ error: { code: string } }>(
      await platform(world, "POST", "/v1/platform/domains/move", {
        body: { hostname: "never-added.td.test", toTenantId: shopB.tenantId },
      }),
      409,
      "unknown hostname",
    );
    expect(body.error.code).toBe("hostname_unknown");
  });

  it("changes nothing when the target does not exist (404) or is closed (409)", async () => {
    const hostname = "stays.td.test";
    const domainId = await addDomain(shopA.tenantId, hostname);
    await bareTenant(world, "td-closed-target");
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/td-closed-target/close"), 200, "close");
    const before = await auditCount();

    await expectOpaque404(
      await platform(world, "POST", "/v1/platform/domains/move", { body: { hostname, toTenantId: "td-nobody" } }),
      "unknown target",
    );
    const closed = await expectJson<{ error: { code: string } }>(
      await platform(world, "POST", "/v1/platform/domains/move", {
        body: { hostname, toTenantId: "td-closed-target" },
      }),
      409,
      "closed target",
    );
    expect(closed.error.code).toBe("tenant_closed");

    expect(await domainByHostname(hostname)).toMatchObject({ domain_id: domainId, tenant_id: shopA.tenantId });
    expect(await auditCount()).toBe(before);
  });

  it("a hostname already on the target answers 200, moved: false, and writes nothing", async () => {
    const before = await auditCount();
    const body = await expectJson<MoveBody>(
      await platform(world, "POST", "/v1/platform/domains/move", {
        body: { hostname: shopB.host, toTenantId: shopB.tenantId },
      }),
      200,
      "no-op move",
    );
    expect(body).toMatchObject({ fromTenantId: shopB.tenantId, moved: false, toTenantId: shopB.tenantId });
    expect(await auditCount()).toBe(before);
  });

  it("frees a closed shop's hostname for an open one", async () => {
    const host = await bareTenant(world, "td-closed-source");
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/td-closed-source/close"), 200, "close");
    await expectJson<MoveBody>(
      await platform(world, "POST", "/v1/platform/domains/move", { body: { hostname: host, toTenantId: shopB.tenantId } }),
      200,
      "move out of a closed shop",
    );
    expect(await resolvesTo(host)).toBe(shopB.tenantId);
  });

  it.each([
    ["an empty body", {}],
    ["a malformed hostname", { hostname: "bad..host", toTenantId: "td-b" }],
    ["an uppercase tenant id", { hostname: "a.td.test", toTenantId: "TD-B" }],
    ["an unknown key", { fromTenantId: "td-a", hostname: "a.td.test", toTenantId: "td-b" }],
    ["a numeric tenant id", { hostname: "a.td.test", toTenantId: 7 }],
  ])("refuses %s", async (_label, body) => {
    await expectJson(await platform(world, "POST", "/v1/platform/domains/move", { body }), 400, "bad move");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("hostname collisions", () => {
  it("adding a hostname another tenant holds answers 409 and leaves it where it was", async () => {
    const body = await expectJson<{ error: { code: string } }>(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/domains`, {
        body: { hostname: shopA.host, kind: "storefront" },
      }),
      409,
      "collision",
    );
    expect(body.error.code).toBe("conflict");
    expect((await domainByHostname(shopA.host))?.tenant_id).toBe(shopA.tenantId);
  });
});
