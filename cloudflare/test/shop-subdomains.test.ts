import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveRequestTenant } from "../src/tenancy/resolve-tenant";
import { shopStorefrontHostname } from "../src/tenancy/shop-hostname";
import {
  canonicalPlatformHostname,
  checkSubdomainLabel,
  defaultSubdomainLabel,
  parsePlatformShopDomain,
  RESERVED_SUBDOMAIN_LABELS,
  SUBDOMAIN_GRACE_MS,
  setSubdomainLabel,
} from "../src/tenancy/subdomain";
import type { PlatformPrincipal } from "../src/auth/live-authorization";
import { call, type CallOptions, instrumentedDb } from "./slice-harness";
import {
  auditRows,
  domainByHostname,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP14 — shop subdomains: the label rules, the schema, the two write routes
 * (the seller's PATCH /v1/admin/settings { subdomainLabel } and the platform's
 * PUT /v1/platform/tenants/:id/subdomain), the default at creation, the grace
 * period of a retired hostname, resolution, and the web Worker's question
 * (`canonicalPlatformHostname`). The feature is OFF in the suites' env
 * (vitest.config.ts); each case that needs it on runs with `on()`.
 */

const BASE = "shops.sub.test";
const ADMIN_SETTINGS = "https://admin.slice.test/v1/admin/settings";

interface SubdomainView {
  baseDomain: string | null;
  hostname: string | null;
  label: string | null;
  previous: Array<{ hostname: string; redirectUntil: string }>;
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;
let shopD: Tenant;

function on(): Env {
  return world.with({ PLATFORM_SHOP_DOMAIN: BASE });
}

function settingsCall(tenant: Tenant, method: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, ADMIN_SETTINGS, {
    body,
    cookie: tenant.adminCookie,
    env: on(),
    shopId: tenant.tenantId,
    ...options,
  });
}

async function setLabel(tenant: Tenant, label: unknown, status = 200) {
  return expectJson<{ subdomain: SubdomainView; error?: { code: string } }>(
    await settingsCall(tenant, "PATCH", { subdomainLabel: label }),
    status,
    `label ${String(label)} for ${tenant.tenantId}`,
  );
}

async function labelOf(tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT subdomain_label FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ subdomain_label: string | null }>();
  return row?.subdomain_label ?? null;
}

async function redirectUntil(hostname: string): Promise<number | null | undefined> {
  const row = await env.DB.prepare("SELECT redirect_until FROM tenant_domains WHERE hostname = ?")
    .bind(hostname)
    .first<{ redirect_until: number | null }>();
  return row === null ? undefined : row.redirect_until;
}

async function resolves(hostname: string): Promise<string | null> {
  return (await resolveRequestTenant(env.DB, new Request(`https://${hostname}/v1/storefront`)))?.tenantId ?? null;
}

beforeAll(async () => {
  const setup = await tenantWorld("sd", 4);
  world = setup.world;
  [shopA, shopB, shopC, shopD] = setup.tenants as [Tenant, Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the label rules", () => {
  it("takes 1–63 of a–z 0–9 and '-', never first or last", () => {
    for (const ok of ["a", "melodiemc", "melodie-mc", "gif-sundsvall", "9", "a1-b2", "x".repeat(63)]) {
      expect(checkSubdomainLabel(ok), ok).toEqual({ label: ok, status: "ok" });
    }
  });

  it("refuses anything else as invalid: case, other characters, edges, length, punycode, non-strings", () => {
    for (const bad of [
      "",
      "Melodie",
      "MELODIE",
      "melodie_mc",
      "melodie.mc",
      "melodie mc",
      " melodie",
      "melodie ",
      "mälodie",
      "-melodie",
      "melodie-",
      "-",
      "x".repeat(64),
      "xn--mlodie-cua",
      "a/b",
      "a%2eb",
    ]) {
      expect(checkSubdomainLabel(bad), JSON.stringify(bad)).toEqual({ status: "invalid" });
    }
    for (const bad of [null, undefined, 42, true, {}, ["a"]]) {
      expect(checkSubdomainLabel(bad), String(bad)).toEqual({ status: "invalid" });
    }
  });

  it("refuses every reserved label as reserved", () => {
    const expected = [
      "admin", "api", "www", "mail", "img", "stg", "staging", "dev", "test", "static", "cdn",
      "status", "help", "support", "docs", "ns1", "ns2", "mta", "smtp", "imap", "pop", "ftp",
    ];
    expect([...RESERVED_SUBDOMAIN_LABELS].sort()).toEqual([...expected].sort());
    for (const label of expected) {
      expect(checkSubdomainLabel(label), label).toEqual({ status: "reserved" });
    }
    // Only the exact label: a shop may be "admins" or "www-shop".
    expect(checkSubdomainLabel("admins")).toEqual({ label: "admins", status: "ok" });
    expect(checkSubdomainLabel("www-shop")).toEqual({ label: "www-shop", status: "ok" });
  });

  it("gives a new shop its id as the default label only when the id passes", () => {
    expect(defaultSubdomainLabel("melodie-mc")).toBe("melodie-mc");
    expect(defaultSubdomainLabel("api")).toBeNull();
    expect(defaultSubdomainLabel("shop-")).toBeNull();
    expect(defaultSubdomainLabel("x".repeat(64))).toBeNull();
  });

  it("reads PLATFORM_SHOP_DOMAIN as a lowercase hostname, anything else as off", () => {
    expect(parsePlatformShopDomain("flippinstuff.se")).toBe("flippinstuff.se");
    expect(parsePlatformShopDomain("stg-shop.invalid")).toBe("stg-shop.invalid");
    for (const off of [undefined, null, "", "se", "Flippinstuff.se", ".flippinstuff.se", "flippinstuff.se.",
      "https://flippinstuff.se", "flippin stuff.se", "*.flippinstuff.se", 42]) {
      expect(parsePlatformShopDomain(off), String(off)).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the schema (0061)", () => {
  it("refuses a malformed label in the column itself", async () => {
    for (const bad of ["Upper", "under_score", "-edge", "edge-", "x".repeat(64), ""]) {
      await expect(
        env.DB.prepare("UPDATE tenants SET subdomain_label = ? WHERE tenant_id = ?").bind(bad, shopD.tenantId).run(),
        bad,
      ).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it("refuses the same label on two shops, and allows many shops without one", async () => {
    await env.DB.prepare("UPDATE tenants SET subdomain_label = 'sd-unique' WHERE tenant_id = ?").bind(shopD.tenantId).run();
    await expect(
      env.DB.prepare("UPDATE tenants SET subdomain_label = 'sd-unique' WHERE tenant_id = ?").bind(shopC.tenantId).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await env.DB.prepare("UPDATE tenants SET subdomain_label = NULL WHERE tenant_id = ?").bind(shopD.tenantId).run();
    const nulls = await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE subdomain_label IS NULL").first<{ n: number }>();
    expect(nulls?.n ?? 0).toBeGreaterThan(1);
  });

  it("backfills the four staging shops that hold <id>.stg-shop.invalid, and nothing else", async () => {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === "0061_shop_subdomains.sql");
    const backfill = migration?.queries.find((query) => query.trimStart().startsWith("UPDATE tenants"));
    expect(backfill).toBeDefined();

    const now = Date.now();
    const seed = async (tenantId: string, hostname: string | null) => {
      await env.DB.prepare(
        `INSERT INTO tenants (tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at)
         VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
      ).bind(tenantId, tenantId, now, now).run();
      if (hostname !== null) {
        await env.DB.prepare(
          `INSERT INTO tenant_domains (domain_id, tenant_id, hostname, kind, status, verified_at, created_at, updated_at)
           VALUES (?, ?, ?, 'storefront', 'verified', ?, ?, ?)`,
        ).bind(crypto.randomUUID(), tenantId, hostname, now, now, now).run();
      }
    };
    await seed("ninetone", "ninetone.stg-shop.invalid");
    await seed("gif-sundsvall", "gif-sundsvall.stg-shop.invalid");
    await seed("sillmans", "sillmans.shop.invalid"); // no staging row: untouched
    await seed("sd-other", "sd-other.stg-shop.invalid"); // not one of the four: untouched

    await env.DB.prepare(backfill as string).run();

    expect(await labelOf("ninetone")).toBe("ninetone");
    expect(await labelOf("gif-sundsvall")).toBe("gif-sundsvall");
    expect(await labelOf("sillmans")).toBeNull();
    expect(await labelOf("sd-other")).toBeNull();
    // The rows are the platform hostnames: canonical, so nothing redirects them.
    expect(await canonicalPlatformHostname(env.DB, "stg-shop.invalid", { shop: "ninetone" }, now)).toBe(
      "ninetone.stg-shop.invalid",
    );
    expect(
      await canonicalPlatformHostname(env.DB, "stg-shop.invalid", { hostname: "ninetone.stg-shop.invalid" }, now),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("feature off (PLATFORM_SHOP_DOMAIN absent)", () => {
  it("creates a shop with no label and no extra hostname", async () => {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: "sd-off.shops.cp3a.test", shopName: "Off", tenantId: "sd-off" },
      }),
      201,
      "create",
    );
    expect(await labelOf("sd-off")).toBeNull();
    expect(await domainByHostname(`sd-off.${BASE}`)).toBeNull();
    expect(await auditRows("sd-off", "tenant.subdomain_set")).toEqual([]);
  });

  it("answers GET with an all-null subdomain, refuses a label write with subdomains_off, redirects nothing", async () => {
    const read = await expectJson<{ subdomain: SubdomainView }>(
      await settingsCall(shopA, "GET", undefined, { env: world.env }),
      200,
      "GET off",
    );
    expect(read.subdomain).toEqual({ baseDomain: null, hostname: null, label: null, previous: [] });

    const refused = await expectJson<{ error: { code: string } }>(
      await settingsCall(shopA, "PATCH", { subdomainLabel: "sd-a-off" }, { env: world.env }),
      409,
      "PATCH off",
    );
    expect(refused.error.code).toBe("subdomains_off");
    const platformRefused = await expectJson<{ error: { code: string } }>(
      await platform(world, "PUT", `/v1/platform/tenants/${shopA.tenantId}/subdomain`, { body: { label: "sd-a-off" } }),
      409,
      "PUT off",
    );
    expect(platformRefused.error.code).toBe("subdomains_off");
    expect(await labelOf(shopA.tenantId)).toBeNull();

    expect(await canonicalPlatformHostname(env.DB, null, { shop: shopA.tenantId }, Date.now())).toBeNull();
    // The real entrypoint reads the suites' env, where the feature is off.
    expect(await exports.Internal.canonicalShopHost({ shop: shopA.tenantId })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the default at creation (feature on)", () => {
  it("gives the shop its id as its label and a verified storefront row, audited", async () => {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: "sd-new.shops.cp3a.test", shopName: "Ny", tenantId: "sd-new" },
        env: on(),
      }),
      201,
      "create",
    );
    expect(await labelOf("sd-new")).toBe("sd-new");
    expect(await domainByHostname(`sd-new.${BASE}`)).toMatchObject({
      kind: "storefront",
      status: "verified",
      tenant_id: "sd-new",
    });
    expect(await resolves(`sd-new.${BASE}`)).toBe("sd-new");
    const audits = await auditRows("sd-new", "tenant.subdomain_set");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ from: null, hostname: `sd-new.${BASE}`, label: "sd-new" });
  });

  it("reuses the creation hostname when it already is <id>.<base> (the staging shape)", async () => {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: `sd-same.${BASE}`, shopName: "Samma", tenantId: "sd-same" },
        env: on(),
      }),
      201,
      "create",
    );
    expect(await labelOf("sd-same")).toBe("sd-same");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM tenant_domains WHERE tenant_id = 'sd-same'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("leaves a shop whose id is reserved or too long without a label, and still creates it", async () => {
    const long = `sd${"x".repeat(62)}`;
    for (const tenantId of ["staging", long]) {
      await expectJson(
        await platform(world, "POST", "/v1/platform/tenants", {
          body: { hostname: `${tenantId.slice(0, 40)}.shops.cp3a.test`, shopName: "R", tenantId },
          env: on(),
        }),
        201,
        `create ${tenantId}`,
      );
      expect(await labelOf(tenantId)).toBeNull();
    }
    expect(await domainByHostname(`staging.${BASE}`)).toBeNull();
  });

  it("leaves a shop without a label when another shop holds its id as label", async () => {
    await setLabel(shopB, "sd-taken-later");
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: "sd-taken-later.shops.cp3a.test", shopName: "T", tenantId: "sd-taken-later" },
        env: on(),
      }),
      201,
      "create",
    );
    expect(await labelOf("sd-taken-later")).toBeNull();
    expect((await domainByHostname(`sd-taken-later.${BASE}`))?.tenant_id).toBe(shopB.tenantId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PATCH /v1/admin/settings { subdomainLabel } — the seller's route", () => {
  it("is the shop's admin's alone: anonymous, another shop's admin, cross-origin get the opaque 404", async () => {
    const body = { subdomainLabel: "sd-hijack" };
    await expectOpaque404(
      await call(world, "PATCH", ADMIN_SETTINGS, { body, env: on(), shopId: shopA.tenantId }),
      "anonymous",
    );
    await expectOpaque404(
      await call(world, "PATCH", ADMIN_SETTINGS, { body, cookie: shopB.adminCookie, env: on(), shopId: shopA.tenantId }),
      "another shop's admin",
    );
    await expectOpaque404(await settingsCall(shopA, "PATCH", body, { origin: "https://evil.test" }), "cross-origin");
    expect(await labelOf(shopA.tenantId)).not.toBe("sd-hijack");
  });

  it("sets a label: the view, the row, resolution, the audit", async () => {
    const answer = await setLabel(shopA, "sd-alfa");
    expect(answer).toEqual({
      subdomain: { baseDomain: BASE, hostname: `sd-alfa.${BASE}`, label: "sd-alfa", previous: [] },
    });
    expect(await resolves(`sd-alfa.${BASE}`)).toBe(shopA.tenantId);
    expect(await shopStorefrontHostname(env.DB, shopA.tenantId)).not.toBeNull();

    const read = await expectJson<{ subdomain: SubdomainView }>(await settingsCall(shopA, "GET"), 200, "GET");
    expect(read.subdomain.label).toBe("sd-alfa");
    const audits = await auditRows(shopA.tenantId, "tenant.subdomain_set");
    expect(audits.at(-1)).toMatchObject({
      actorUserId: shopA.adminUserId,
      metadata: { from: null, hostname: `sd-alfa.${BASE}`, label: "sd-alfa", retiredHostname: null },
    });
  });

  it("answers the same label again with 200 and writes nothing", async () => {
    await setLabel(shopA, "sd-alfa");
    const before = (await auditRows(shopA.tenantId, "tenant.subdomain_set")).length;
    const again = await setLabel(shopA, "sd-alfa");
    expect(again.subdomain.label).toBe("sd-alfa");
    expect(await auditRows(shopA.tenantId, "tenant.subdomain_set")).toHaveLength(before);
  });

  it("refuses an invalid label (subdomain_invalid) and a reserved one (subdomain_reserved), writing nothing", async () => {
    await setLabel(shopA, "sd-alfa");
    for (const bad of ["Sd-Alfa", "sd_alfa", "sd.alfa", "-sd", "x".repeat(64), "", "xn--abc"]) {
      const refused = await setLabel(shopA, bad, 400);
      expect(refused.error?.code, bad).toBe("subdomain_invalid");
    }
    for (const reserved of ["admin", "api", "www", "mail", "img", "ftp"]) {
      const refused = await setLabel(shopA, reserved, 400);
      expect(refused.error?.code, reserved).toBe("subdomain_reserved");
    }
    expect(await labelOf(shopA.tenantId)).toBe("sd-alfa");
  });

  it("refuses a non-string label, and a body that mixes the label with settings fields", async () => {
    for (const body of [
      { subdomainLabel: null },
      { subdomainLabel: 7 },
      { expectedUpdatedAt: null, subdomainLabel: "sd-mixed" },
      { returnAddress: "Gatan 1", subdomainLabel: "sd-mixed" },
    ]) {
      const refused = await expectJson<{ error: { code: string } }>(
        await settingsCall(shopA, "PATCH", body),
        400,
        JSON.stringify(body),
      );
      expect(refused.error.code).toBe("invalid_request");
    }
    expect(await labelOf(shopA.tenantId)).not.toBe("sd-mixed");
  });

  it("refuses another shop's label as subdomain_taken", async () => {
    await setLabel(shopA, "sd-alfa");
    const refused = await setLabel(shopB, "sd-alfa", 409);
    expect(refused.error?.code).toBe("subdomain_taken");
  });

  it("refuses a hostname another shop holds by hand (a domain added under the base) as taken", async () => {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopD.tenantId}/domains`, {
        body: { hostname: `sd-hand.${BASE}`, kind: "storefront" },
      }),
      201,
      "add by hand",
    );
    const refused = await setLabel(shopC, "sd-hand", 409);
    expect(refused.error?.code).toBe("subdomain_taken");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("changing the label — the grace period", () => {
  it("makes the new hostname canonical and keeps the old one resolving and redirecting until its grace ends", async () => {
    await setLabel(shopC, "sd-gamla");
    const before = Date.now();
    const answer = await setLabel(shopC, "sd-nya");
    const after = Date.now();

    expect(answer.subdomain.label).toBe("sd-nya");
    expect(answer.subdomain.hostname).toBe(`sd-nya.${BASE}`);
    expect(answer.subdomain.previous.map((entry) => entry.hostname)).toEqual([`sd-gamla.${BASE}`]);
    const until = await redirectUntil(`sd-gamla.${BASE}`);
    expect(until).toBeGreaterThanOrEqual(before + SUBDOMAIN_GRACE_MS);
    expect(until).toBeLessThanOrEqual(after + SUBDOMAIN_GRACE_MS);
    expect(await redirectUntil(`sd-nya.${BASE}`)).toBeNull();

    // Both resolve to the shop; only the new one is what /<shop>/ maps to.
    expect(await resolves(`sd-nya.${BASE}`)).toBe(shopC.tenantId);
    expect(await resolves(`sd-gamla.${BASE}`)).toBe(shopC.tenantId);
    const mapped = await shopStorefrontHostname(env.DB, shopC.tenantId);
    expect(mapped).not.toBe(`sd-gamla.${BASE}`);

    // The web Worker's question.
    const now = Date.now();
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `sd-gamla.${BASE}` }, now)).toBe(`sd-nya.${BASE}`);
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `sd-nya.${BASE}` }, now)).toBeNull();
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: shopC.tenantId }, now)).toBe(`sd-nya.${BASE}`);

    const audits = await auditRows(shopC.tenantId, "tenant.subdomain_set");
    expect(audits.at(-1)?.metadata).toMatchObject({
      from: "sd-gamla",
      label: "sd-nya",
      retiredHostname: `sd-gamla.${BASE}`,
    });
  });

  it("keeps the old label taken for other shops during the grace", async () => {
    const refused = await setLabel(shopB, "sd-gamla", 409);
    expect(refused.error?.code).toBe("subdomain_taken");
  });

  it("stops resolving and redirecting the old hostname once the grace is over, and frees it", async () => {
    await env.DB.prepare("UPDATE tenant_domains SET redirect_until = 1 WHERE hostname = ?").bind(`sd-gamla.${BASE}`).run();
    expect(await resolves(`sd-gamla.${BASE}`)).toBeNull();
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `sd-gamla.${BASE}` }, Date.now())).toBeNull();

    const read = await expectJson<{ subdomain: SubdomainView }>(await settingsCall(shopC, "GET"), 200, "GET");
    expect(read.subdomain.previous).toEqual([]);

    // Another shop claims it: the expired row is deleted in the same batch.
    const claimed = await setLabel(shopB, "sd-gamla");
    expect(claimed.subdomain.label).toBe("sd-gamla");
    expect((await domainByHostname(`sd-gamla.${BASE}`))?.tenant_id).toBe(shopB.tenantId);
    expect(await redirectUntil(`sd-gamla.${BASE}`)).toBeNull();
    expect(await resolves(`sd-gamla.${BASE}`)).toBe(shopB.tenantId);
  });

  it("takes a shop back to a label it held before: the row is un-retired, the current one retired", async () => {
    await setLabel(shopD, "sd-ett");
    await setLabel(shopD, "sd-tva");
    const back = await setLabel(shopD, "sd-ett");
    expect(back.subdomain.label).toBe("sd-ett");
    expect(await redirectUntil(`sd-ett.${BASE}`)).toBeNull();
    expect(await redirectUntil(`sd-tva.${BASE}`)).toBeGreaterThan(Date.now());
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tenant_domains WHERE tenant_id = ? AND hostname = ?",
    ).bind(shopD.tenantId, `sd-ett.${BASE}`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("answers no redirect for a shop without a label, an unknown shop, a malformed target, or a host outside the base", async () => {
    const now = Date.now();
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: "sd-off" }, now)).toBeNull();
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: "sd-nobody" }, now)).toBeNull();
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: "Not A Shop" }, now)).toBeNull();
    for (const target of [null, "sd-nya", 7, {}, { shop: 7 }, { hostname: null }]) {
      expect(await canonicalPlatformHostname(env.DB, BASE, target, now), JSON.stringify(target)).toBeNull();
    }
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: "sd-nya.elsewhere.test" }, now)).toBeNull();
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `a.b.${BASE}` }, now)).toBeNull();
  });

  it("answers no redirect for a suspended shop", async () => {
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").bind(shopC.tenantId).run();
    try {
      expect(await canonicalPlatformHostname(env.DB, BASE, { shop: shopC.tenantId }, Date.now())).toBeNull();
    } finally {
      await env.DB.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").bind(shopC.tenantId).run();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET/PUT /v1/platform/tenants/:id/subdomain — the platform's route", () => {
  it("reads and sets any shop's label, with the seller route's refusals", async () => {
    const set = await expectJson<{ subdomain: SubdomainView; tenantId: string }>(
      await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/subdomain`, {
        body: { label: "sd-bravo" },
        env: on(),
      }),
      200,
      "PUT",
    );
    expect(set).toEqual({
      subdomain: {
        baseDomain: BASE,
        hostname: `sd-bravo.${BASE}`,
        label: "sd-bravo",
        // Newest first: B left sd-gamla just now, sd-taken-later before that.
        previous: [
          { hostname: `sd-gamla.${BASE}`, redirectUntil: expect.any(String) },
          { hostname: `sd-taken-later.${BASE}`, redirectUntil: expect.any(String) },
        ],
      },
      tenantId: shopB.tenantId,
    });
    const audits = await auditRows(shopB.tenantId, "tenant.subdomain_set");
    expect(audits.at(-1)?.actorUserId).toBe(world.platformUserId);

    const read = await expectJson<{ subdomain: SubdomainView }>(
      await platform(world, "GET", `/v1/platform/tenants/${shopB.tenantId}/subdomain`, { env: on() }),
      200,
      "GET",
    );
    expect(read.subdomain.label).toBe("sd-bravo");

    for (const [label, status, code] of [
      ["admin", 400, "subdomain_reserved"],
      ["Bravo", 400, "subdomain_invalid"],
      ["sd-alfa", 409, "subdomain_taken"],
    ] as const) {
      const refused = await expectJson<{ error: { code: string } }>(
        await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/subdomain`, { body: { label }, env: on() }),
        status,
        label,
      );
      expect(refused.error.code).toBe(code);
    }
    for (const body of [{}, { label: 7 }, { label: "sd-x", extra: 1 }, { subdomainLabel: "sd-x" }]) {
      await expectJson(
        await platform(world, "PUT", `/v1/platform/tenants/${shopB.tenantId}/subdomain`, { body, env: on() }),
        400,
        JSON.stringify(body),
      );
    }
  });

  it("is the platform's alone, and answers 404 for an unknown shop", async () => {
    const path = `/v1/platform/tenants/${shopA.tenantId}/subdomain`;
    await expectOpaque404(
      await call(world, "PUT", `https://platform.slice.test${path}`, {
        body: { label: "sd-hijack" },
        cookie: shopA.adminCookie,
        env: on(),
        shopId: shopA.tenantId,
      }),
      "tenant admin",
    );
    await expectOpaque404(
      await call(world, "GET", `https://platform.slice.test${path}`, { env: on() }),
      "anonymous",
    );
    await expectOpaque404(
      await platform(world, "PUT", "/v1/platform/tenants/sd-nobody/subdomain", { body: { label: "sd-x" }, env: on() }),
      "unknown shop",
    );
    await expectOpaque404(
      await platform(world, "GET", "/v1/platform/tenants/sd-nobody/subdomain", { env: on() }),
      "unknown shop GET",
    );
  });

  it("refuses a label for a closed shop", async () => {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: "sd-closing.shops.cp3a.test", shopName: "Stänger", tenantId: "sd-closing" },
      }),
      201,
      "create",
    );
    await expectJson(await platform(world, "POST", "/v1/platform/tenants/sd-closing/close", {}), 200, "close");
    const refused = await expectJson<{ error: { code: string } }>(
      await platform(world, "PUT", "/v1/platform/tenants/sd-closing/subdomain", { body: { label: "sd-closing" }, env: on() }),
      409,
      "closed",
    );
    expect(refused.error.code).toBe("conflict");
    expect(await labelOf("sd-closing")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Codex round 1 on b7a1112d", () => {
  const OPERATOR: PlatformPrincipal = { accountType: "platform_admin", userId: "sd-operator" };

  async function bare(tenantId: string): Promise<void> {
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants", {
        body: { hostname: `${tenantId}.shops.cp3a.test`, shopName: tenantId, tenantId },
      }),
      201,
      `create ${tenantId}`,
    );
  }

  async function domainRow(hostname: string) {
    return env.DB.prepare("SELECT tenant_id, kind, status, redirect_until FROM tenant_domains WHERE hostname = ?")
      .bind(hostname)
      .first<{ kind: string; redirect_until: number | null; status: string; tenant_id: string }>();
  }

  it("P2: taking back an own retired hostname an operator disabled restores it verified, and it resolves", async () => {
    await bare("sd-r1");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r1", "sd-r1-a", BASE, Date.now())).status).toBe("ok");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r1", "sd-r1-b", BASE, Date.now())).status).toBe("ok");
    await env.DB.prepare("UPDATE tenant_domains SET status = 'disabled' WHERE hostname = ?").bind(`sd-r1-a.${BASE}`).run();

    const back = await setSubdomainLabel(env.DB, OPERATOR, "sd-r1", "sd-r1-a", BASE, Date.now());
    expect(back.status).toBe("ok");
    expect(await domainRow(`sd-r1-a.${BASE}`)).toMatchObject({ redirect_until: null, status: "verified" });
    expect(await resolves(`sd-r1-a.${BASE}`)).toBe("sd-r1");
    expect((await domainRow(`sd-r1-b.${BASE}`))?.redirect_until).toBeGreaterThan(Date.now());
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: "sd-r1" }, Date.now())).toBe(`sd-r1-a.${BASE}`);
  });

  it("P2: the same label again restores its disabled row", async () => {
    await env.DB.prepare("UPDATE tenant_domains SET status = 'disabled' WHERE hostname = ?").bind(`sd-r1-a.${BASE}`).run();
    const again = await setSubdomainLabel(env.DB, OPERATOR, "sd-r1", "sd-r1-a", BASE, Date.now());
    expect(again).toMatchObject({ changed: false, status: "ok" });
    expect((await domainRow(`sd-r1-a.${BASE}`))?.status).toBe("verified");
  });

  it("P2: an own row of the hostname that is not a storefront row is refused, nothing retired", async () => {
    await bare("sd-r2");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r2", "sd-r2-live", BASE, Date.now())).status).toBe("ok");
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants/sd-r2/domains", {
        body: { hostname: `sd-r2-adm.${BASE}`, kind: "admin" },
      }),
      201,
      "admin row",
    );
    const audits = (await auditRows("sd-r2", "tenant.subdomain_set")).length;

    const refused = await setSubdomainLabel(env.DB, OPERATOR, "sd-r2", "sd-r2-adm", BASE, Date.now());
    expect(refused).toEqual({ status: "conflict" });
    expect(await labelOf("sd-r2")).toBe("sd-r2-live");
    expect(await domainRow(`sd-r2-live.${BASE}`)).toMatchObject({ redirect_until: null, status: "verified" });
    expect(await domainRow(`sd-r2-adm.${BASE}`)).toMatchObject({ kind: "admin", redirect_until: null });
    expect(await auditRows("sd-r2", "tenant.subdomain_set")).toHaveLength(audits);
  });

  it("P2: of two concurrent A→B requests the loser writes no audit row and no domain row", async () => {
    await bare("sd-r3");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r3", "sd-r3-a", BASE, Date.now())).status).toBe("ok");
    const audits = (await auditRows("sd-r3", "tenant.subdomain_set")).length;

    let winner: Awaited<ReturnType<typeof setSubdomainLabel>> | null = null;
    const loser = instrumentedDb(async (op) => {
      // The loser has read label A; the winner commits A → B before its label UPDATE.
      if (winner === null && op.kind === "run" && op.sql[0]?.includes("SET subdomain_label = ?")) {
        winner = await setSubdomainLabel(env.DB, OPERATOR, "sd-r3", "sd-r3-b", BASE, Date.now());
      }
    });
    const lost = await setSubdomainLabel(loser.db, OPERATOR, "sd-r3", "sd-r3-b", BASE, Date.now());

    expect(winner).toMatchObject({ changed: true, status: "ok" });
    expect(lost).toEqual({ status: "conflict" });
    expect(loser.ops.some((op) => op.kind === "batch")).toBe(false);
    expect(await auditRows("sd-r3", "tenant.subdomain_set")).toHaveLength(audits + 1);
    const rows = await env.DB.prepare("SELECT hostname FROM tenant_domains WHERE tenant_id = 'sd-r3' ORDER BY hostname")
      .all<{ hostname: string }>();
    expect(rows.results.map((row) => row.hostname)).toEqual([
      `sd-r3-a.${BASE}`,
      `sd-r3-b.${BASE}`,
      "sd-r3.shops.cp3a.test",
    ]);
  });

  it("a crash between the two steps resolves nothing wrongly, and the next identical write completes it", async () => {
    await bare("sd-r4");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r4", "sd-r4-a", BASE, Date.now())).status).toBe("ok");
    const dying = instrumentedDb((op) => {
      if (op.kind === "batch") {
        throw new Error("worker died");
      }
    });
    await expect(setSubdomainLabel(dying.db, OPERATOR, "sd-r4", "sd-r4-b", BASE, Date.now())).rejects.toThrow(
      "worker died",
    );
    // Label moved, its row missing; the old address is still live and canonical redirects nothing.
    expect(await labelOf("sd-r4")).toBe("sd-r4-b");
    expect(await domainRow(`sd-r4-b.${BASE}`)).toBeNull();
    expect(await resolves(`sd-r4-a.${BASE}`)).toBe("sd-r4");
    expect(await canonicalPlatformHostname(env.DB, BASE, { shop: "sd-r4" }, Date.now())).toBeNull();

    const completed = await setSubdomainLabel(env.DB, OPERATOR, "sd-r4", "sd-r4-b", BASE, Date.now());
    expect(completed).toMatchObject({ changed: false, status: "ok" });
    expect(await domainRow(`sd-r4-b.${BASE}`)).toMatchObject({ redirect_until: null, status: "verified" });
    expect((await domainRow(`sd-r4-a.${BASE}`))?.redirect_until).toBeGreaterThan(Date.now());
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `sd-r4-a.${BASE}` }, Date.now())).toBe(
      `sd-r4-b.${BASE}`,
    );
    // The creation hostname is not under the base: never retired.
    expect((await domainRow("sd-r4.shops.cp3a.test"))?.redirect_until).toBeNull();
  });

  it("round 2: an interrupted A→B where B already was a live alias — the retry retires A and audits once; then a true no-op writes nothing", async () => {
    await bare("sd-r5");
    expect((await setSubdomainLabel(env.DB, OPERATOR, "sd-r5", "sd-r5-a", BASE, Date.now())).status).toBe("ok");
    await expectJson(
      await platform(world, "POST", "/v1/platform/tenants/sd-r5/domains", {
        body: { hostname: `sd-r5-b.${BASE}`, kind: "storefront" },
      }),
      201,
      "alias by hand",
    );
    const dying = instrumentedDb((op) => {
      if (op.kind === "batch") {
        throw new Error("worker died");
      }
    });
    await expect(setSubdomainLabel(dying.db, OPERATOR, "sd-r5", "sd-r5-b", BASE, Date.now())).rejects.toThrow();
    expect(await labelOf("sd-r5")).toBe("sd-r5-b");
    expect((await domainRow(`sd-r5-a.${BASE}`))?.redirect_until).toBeNull();
    const audits = (await auditRows("sd-r5", "tenant.subdomain_set")).length;

    const retry = await setSubdomainLabel(env.DB, OPERATOR, "sd-r5", "sd-r5-b", BASE, Date.now());
    expect(retry).toMatchObject({ changed: false, status: "ok" });
    expect((await domainRow(`sd-r5-a.${BASE}`))?.redirect_until).toBeGreaterThan(Date.now());
    expect(await domainRow(`sd-r5-b.${BASE}`)).toMatchObject({ redirect_until: null, status: "verified" });
    expect(await canonicalPlatformHostname(env.DB, BASE, { hostname: `sd-r5-a.${BASE}` }, Date.now())).toBe(
      `sd-r5-b.${BASE}`,
    );
    const after = await auditRows("sd-r5", "tenant.subdomain_set");
    expect(after).toHaveLength(audits + 1);
    expect(after.at(-1)?.metadata).toMatchObject({
      from: "sd-r5-b",
      label: "sd-r5-b",
      retiredHostnames: [`sd-r5-a.${BASE}`],
    });

    // Now there is nothing left to do: the same label writes nothing at all.
    const watched = instrumentedDb(() => undefined);
    const noop = await setSubdomainLabel(watched.db, OPERATOR, "sd-r5", "sd-r5-b", BASE, Date.now());
    expect(noop).toMatchObject({ changed: false, status: "ok" });
    expect(watched.ops.filter((op) => op.kind === "run" || op.kind === "batch")).toEqual([]);
    expect(await auditRows("sd-r5", "tenant.subdomain_set")).toHaveLength(audits + 1);
  });
});
