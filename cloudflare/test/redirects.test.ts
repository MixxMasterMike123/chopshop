import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  encodeStorefrontPath,
  normalizeStorefrontPath,
  parseRedirectFromPath,
  parseRedirectToPath,
  REDIRECTS_PER_CALL_MAX,
} from "../src/storefront/redirects";
import { ADMIN, call, type CallOptions } from "./slice-harness";
import {
  auditCount,
  auditRows,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP4-D — permanent forwards (D88): the one path normal form, the admin
 * routes, the SEO answer, and the 0043 schema as the last fence.
 */

interface RedirectsBody {
  nextCursor: string | null;
  redirects: Array<{ createdAt: string; createdBy: string; fromPath: string; toPath: string }>;
}

interface RefusedBody {
  error: { code: string; problems: Array<{ index: number; reason: string }> };
}

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;

function redirectsCall(tenant: Tenant, method: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, `${ADMIN}/v1/admin/redirects`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

function listCall(tenant: Tenant, query = "") {
  return call(world, "GET", `${ADMIN}/v1/admin/redirects${query}`, {
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
  });
}

async function put(tenant: Tenant, redirects: Array<{ fromPath: unknown; toPath: unknown }>) {
  return redirectsCall(tenant, "PUT", { redirects });
}

async function seo(tenant: Tenant, path: string): Promise<Response> {
  return call(world, "GET", `https://${tenant.host}/v1/seo?path=${encodeURIComponent(path)}`);
}

async function storedRows(tenantId: string) {
  const rows = await env.DB.prepare(
    "SELECT from_path, to_path FROM redirects WHERE tenant_id = ? ORDER BY from_path",
  )
    .bind(tenantId)
    .all<{ from_path: string; to_path: string }>();
  return rows.results;
}

beforeAll(async () => {
  const setup = await tenantWorld("rd", 2);
  world = setup.world;
  [shopA, shopB] = setup.tenants as [Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("normalizeStorefrontPath — ONE normal form, at write and at lookup", () => {
  it.each([
    ["/products/%F0%9F%98%80-tee", "/products/😀-tee"],
    ["/products/😀-tee", "/products/😀-tee"],
    ["/products/%f0%9f%98%80-tee", "/products/😀-tee"],
    ["/samling/år", "/samling/år"], // NFD → NFC
    ["/samling/%C3%A5r", "/samling/år"],
    ["/blogs/news/", "/blogs/news"],
    ["/blogs/news///", "/blogs/news"],
    ["/blogs/news?page=2#top", "/blogs/news"],
    ["/Blogs/News", "/Blogs/News"], // case kept as given
    ["/a%20b", "/a b"],
    ["/a+b", "/a+b"],
    ["/", "/"],
    ["/?q=1", "/"],
    ["/%3Fnot-a-query", "/?not-a-query"],
  ])("%s → %s", (raw, normal) => {
    expect(normalizeStorefrontPath(raw)).toBe(normal);
  });

  it.each([
    ["no leading slash", "products/x"],
    ["empty", ""],
    ["an empty segment", "/a//b"],
    ["a leading double slash", "//evil.test/x"],
    ["a backslash", "/a\\b"],
    ["an encoded backslash", "/a%5Cb"],
    ["an encoded slash", "/a%2Fb"],
    ["a dot segment", "/a/./b"],
    ["a parent segment", "/a/../b"],
    ["an encoded parent segment", "/a/%2e%2e/b"],
    ["an encoded dot segment", "/%2E/b"],
    ["a malformed escape", "/a%E0%A4%A"],
    ["a lone percent", "/100%-cotton"],
    ["invalid UTF-8", "/a%C3"],
    ["a control character", "/a%00b"],
    ["a raw control character", "/a\u0007b"],
    ["a C1 control", "/a%C2%85b"],
    ["an overlong path", `/${"a".repeat(2_048)}`],
  ])("refuses %s", (_label, raw) => {
    expect(normalizeStorefrontPath(raw)).toBeNull();
  });

  it("writes a stored path back as an address, each segment encoded", () => {
    expect(encodeStorefrontPath("/samling/år (2024)!")).toBe("/samling/%C3%A5r%20%282024%29%21");
    expect(encodeStorefrontPath("/")).toBe("/");
  });
});

describe("a forward's two paths", () => {
  it.each([
    ["a scheme", "javascript:alert(1)"],
    ["an absolute address", "https://evil.test/x"],
    ["a host", "//evil.test/x"],
    ["a backslash host", "/\\evil.test"],
    ["an encoded host", "/%2F%2Fevil.test"],
    ["a parent segment", "/../other-shop/x"],
    ["an encoded parent segment", "/%2e%2e/other-shop"],
    ["a query", "/produkter?alla=1"],
    ["a fragment", "/produkter#x"],
    ["a control character", "/a%0Ab"],
    ["not a string", 42],
  ])("a target with %s is refused", (_label, value) => {
    expect(parseRedirectToPath(value)).toEqual({ ok: false, reason: "invalid_path" });
  });

  it.each([
    ["/"],
    ["/cart"],
    ["/checkout/x"],
    ["/Checkout"],
    ["/order-confirmation/abc"],
    ["/_api/v1/storefront"],
    ["/sitemap.xml"],
    ["/robots.txt"],
    ["/?q"],
  ])("a forward from %s is refused (the shop needs that path)", (from) => {
    expect(parseRedirectFromPath(from)).toEqual({ ok: false, reason: "reserved_path" });
  });

  it("accepts the addresses an importer brings", () => {
    expect(parseRedirectFromPath("/blogs/nyheter/%F0%9F%8E%B8-release")).toEqual({
      ok: true,
      path: "/blogs/nyheter/🎸-release",
    });
    expect(parseRedirectToPath("/samling/nyheter")).toEqual({ ok: true, path: "/samling/nyheter" });
    expect(parseRedirectToPath("/")).toEqual({ ok: true, path: "/" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("who may read and write the forwards", () => {
  it("anonymous, another shop's admin, a platform user without a grant, a foreign or missing origin and another method get the opaque 404", async () => {
    const audits = await auditCount();
    const body = { redirects: [{ fromPath: "/old", toPath: "/new" }] };
    await expectOpaque404(await call(world, "GET", `${ADMIN}/v1/admin/redirects`, { shopId: shopA.tenantId }), "anon GET");
    await expectOpaque404(
      await call(world, "PUT", `${ADMIN}/v1/admin/redirects`, { body, shopId: shopA.tenantId }),
      "anon PUT",
    );
    const asB = { cookie: shopB.adminCookie, shopId: shopA.tenantId };
    await expectOpaque404(await call(world, "GET", `${ADMIN}/v1/admin/redirects`, asB), "B reads A");
    await expectOpaque404(await call(world, "PUT", `${ADMIN}/v1/admin/redirects`, { ...asB, body }), "B writes A");
    await expectOpaque404(
      await call(world, "DELETE", `${ADMIN}/v1/admin/redirects`, { ...asB, body: { fromPaths: ["/old"] } }),
      "B deletes A",
    );
    await expectOpaque404(
      await call(world, "GET", `${ADMIN}/v1/admin/redirects`, { cookie: world.platformCookie, shopId: shopA.tenantId }),
      "platform without a grant",
    );
    for (const origin of ["https://evil.test", null]) {
      await expectOpaque404(await redirectsCall(shopA, "PUT", body, { origin }), `PUT origin=${origin}`);
      await expectOpaque404(
        await redirectsCall(shopA, "DELETE", { fromPaths: ["/old"] }, { origin }),
        `DELETE origin=${origin}`,
      );
    }
    for (const method of ["POST", "PATCH"]) {
      await expectOpaque404(await redirectsCall(shopA, method, body), method);
    }
    await expectOpaque404(await redirectsCall(shopA, "GET", undefined, { shopId: undefined }), "no X-Shop-Id");
    expect(await storedRows(shopA.tenantId)).toEqual([]);
    expect(await auditCount()).toBe(audits);
  });

  it("a platform user with an acting-as grant writes, audited with the grant", async () => {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "import" } }),
      201,
      "grant",
    );
    const asPlatform = { cookie: world.platformCookie, shopId: shopB.tenantId };
    await expectJson(
      await call(world, "PUT", `${ADMIN}/v1/admin/redirects`, {
        ...asPlatform,
        body: { redirects: [{ fromPath: "/support-old", toPath: "/" }] },
      }),
      200,
      "acting-as PUT",
    );
    const [audit] = (await auditRows(shopB.tenantId, "storefront.redirects_put")).slice(-1);
    expect(audit?.actorUserId).toBe(world.platformUserId);
    expect(audit?.metadata).toMatchObject({ actingAsGrantId: expect.any(String), count: 1 });
    await expectJson(
      await call(world, "DELETE", `${ADMIN}/v1/admin/redirects`, { ...asPlatform, body: { fromPaths: ["/support-old"] } }),
      204,
      "acting-as DELETE",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PUT /v1/admin/redirects", () => {
  it("writes the forwards in the normal form, audited, and the SEO answer forwards (encoded)", async () => {
    const audits = (await auditRows(shopA.tenantId, "storefront.redirects_put")).length;
    const written = await expectJson<RedirectsBody>(
      await put(shopA, [
        { fromPath: "/products/%F0%9F%98%80-tee", toPath: "/product/smiley-tee" },
        { fromPath: "/collections/%C3%A5r/", toPath: "/samling/år" },
        { fromPath: "/blogs/news/first-post?utm=x", toPath: "/forsta-inlagget" },
      ]),
      200,
      "put",
    );
    expect(written.redirects.map((entry) => [entry.fromPath, entry.toPath])).toEqual([
      ["/products/😀-tee", "/product/smiley-tee"],
      ["/collections/år", "/samling/år"],
      ["/blogs/news/first-post", "/forsta-inlagget"],
    ]);
    expect(written.redirects[0]).toMatchObject({ createdBy: shopA.adminUserId });
    expect(await storedRows(shopA.tenantId)).toEqual([
      { from_path: "/blogs/news/first-post", to_path: "/forsta-inlagget" },
      { from_path: "/collections/år", to_path: "/samling/år" },
      { from_path: "/products/😀-tee", to_path: "/product/smiley-tee" },
    ]);
    expect((await auditRows(shopA.tenantId, "storefront.redirects_put")).length).toBe(audits + 1);

    // The lookup normalises the same way, whichever spelling the visitor used.
    for (const asked of ["/products/😀-tee", "/products/%F0%9F%98%80-tee", "/products/%f0%9f%98%80-tee/", "/products/😀-tee?ref=x"]) {
      await expect(expectJson(await seo(shopA, asked), 200, asked)).resolves.toEqual({
        redirect: { status: 301, to: "/product/smiley-tee" },
      });
    }
    await expect(expectJson(await seo(shopA, "/collections/%C3%A5r"), 200, "år")).resolves.toEqual({
      redirect: { status: 301, to: "/samling/%C3%A5r" },
    });
    // Another shop's forward is not this shop's.
    await expectJson(await seo(shopB, "/products/😀-tee"), 404, "B has no such forward");
  });

  it("gives an existing path its new target", async () => {
    await expectJson(await put(shopA, [{ fromPath: "/blogs/news/first-post", toPath: "/om-oss" }]), 200, "update");
    expect((await storedRows(shopA.tenantId)).find((row) => row.from_path === "/blogs/news/first-post")?.to_path).toBe(
      "/om-oss",
    );
  });

  it("refuses a chain or a loop, inside the batch and against what is stored, and writes nothing", async () => {
    const before = await storedRows(shopA.tenantId);
    const cases: Array<[string, Array<{ fromPath: string; toPath: string }>, Array<{ index: number; reason: string }>]> = [
      ["a chain in the batch", [{ fromPath: "/x1", toPath: "/x2" }, { fromPath: "/x2", toPath: "/x3" }], [{ index: 0, reason: "chain" }]],
      ["a loop in the batch", [{ fromPath: "/y1", toPath: "/y2" }, { fromPath: "/y2", toPath: "/y1" }], [{ index: 0, reason: "chain" }, { index: 1, reason: "chain" }]],
      ["a forward to itself", [{ fromPath: "/z1", toPath: "/z1/" }], [{ index: 0, reason: "same_path" }]],
      ["a target that is a stored forward", [{ fromPath: "/w1", toPath: "/products/😀-tee" }], [{ index: 0, reason: "chain" }]],
      ["a path that is a stored target", [{ fromPath: "/product/smiley-tee", toPath: "/w2" }], [{ index: 0, reason: "chain" }]],
      ["the same path twice", [{ fromPath: "/v1", toPath: "/v2" }, { fromPath: "/v1/", toPath: "/v3" }], [{ index: 1, reason: "duplicate" }]],
      ["a bad target", [{ fromPath: "/u1", toPath: "https://evil.test" }, { fromPath: "/cart", toPath: "/" }], [{ index: 0, reason: "invalid_path" }, { index: 1, reason: "reserved_path" }]],
    ];
    for (const [label, redirects, problems] of cases) {
      const body = await expectJson<RefusedBody>(await put(shopA, redirects), 400, label);
      expect(body.error.code, label).toBe("refused_redirects");
      expect(body.error.problems, label).toEqual(problems);
    }
    expect(await storedRows(shopA.tenantId)).toEqual(before);
  });

  it.each([
    ["no body", undefined],
    ["an array", []],
    ["no entries", { redirects: [] }],
    ["another key", { redirects: [{ fromPath: "/a", toPath: "/b" }], other: 1 }],
    ["an entry with another key", { redirects: [{ fromPath: "/a", note: "x", toPath: "/b" }] }],
    ["over the cap", { redirects: Array.from({ length: REDIRECTS_PER_CALL_MAX + 1 }, (_, i) => ({ fromPath: `/c${i}`, toPath: "/" })) }],
  ])("refuses %s", async (label, body) => {
    const response = await redirectsCall(shopA, "PUT", body);
    const parsed = await expectJson<{ error: { code: string } }>(response, 400, label);
    expect(["invalid_request", "refused_redirects"]).toContain(parsed.error.code);
  });

  it("writes 500 forwards in one call, one batch, one audit row", async () => {
    const audits = (await auditRows(shopB.tenantId, "storefront.redirects_put")).length;
    const redirects = Array.from({ length: REDIRECTS_PER_CALL_MAX }, (_, i) => ({
      fromPath: `/gammal/${String(i).padStart(3, "0")}`,
      toPath: "/produkter",
    }));
    await expectJson(await put(shopB, redirects), 200, "500");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM redirects WHERE tenant_id = ? AND from_path LIKE '/gammal/%'")
      .bind(shopB.tenantId)
      .first<{ n: number }>();
    expect(count?.n).toBe(REDIRECTS_PER_CALL_MAX);
    expect((await auditRows(shopB.tenantId, "storefront.redirects_put")).length).toBe(audits + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /v1/admin/redirects", () => {
  it("walks every forward once with the keyset cursor", async () => {
    const all = await env.DB.prepare("SELECT from_path FROM redirects WHERE tenant_id = ? ORDER BY from_path")
      .bind(shopB.tenantId)
      .all<{ from_path: string }>();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=170" : `?limit=170&cursor=${encodeURIComponent(cursor)}`;
      const page: RedirectsBody = await expectJson<RedirectsBody>(await listCall(shopB, query), 200, `page ${pages}`);
      seen.push(...page.redirects.map((entry) => entry.fromPath));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.results.map((row) => row.from_path));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("shows only this shop's forwards", async () => {
    const page = await expectJson<RedirectsBody>(await listCall(shopA, "?limit=500"), 200, "A");
    expect(page.redirects.some((entry) => entry.fromPath.startsWith("/gammal/"))).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ["a forged cursor", "?cursor=bm90LWEtcGF0aA"],
    ["a cursor of bad characters", "?cursor=%2F%2F"],
    ["limit 0", "?limit=0"],
    ["limit 501", "?limit=501"],
    ["a text limit", "?limit=ten"],
    ["two limits", "?limit=1&limit=2"],
    ["another parameter", "?tenantId=rd-a"],
  ])("refuses %s", async (label, query) => {
    await expectJson(await listCall(shopA, query), 400, label);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("DELETE /v1/admin/redirects", () => {
  it("removes the named forwards (any spelling), ignores unknown ones, audited", async () => {
    const audits = (await auditRows(shopA.tenantId, "storefront.redirects_delete")).length;
    const response = await redirectsCall(shopA, "DELETE", {
      fromPaths: ["/products/%F0%9F%98%80-tee", "/never-written"],
    });
    expect(response.status).toBe(204);
    expect((await storedRows(shopA.tenantId)).some((row) => row.from_path === "/products/😀-tee")).toBe(false);
    expect((await auditRows(shopA.tenantId, "storefront.redirects_delete")).length).toBe(audits + 1);
    await expectJson(await seo(shopA, "/products/😀-tee"), 404, "no forward any more");
  });

  it.each([
    ["no body", undefined],
    ["no paths", { fromPaths: [] }],
    ["a bad path", { fromPaths: ["no-slash"] }],
    ["over the cap", { fromPaths: Array.from({ length: REDIRECTS_PER_CALL_MAX + 1 }, (_, i) => `/d${i}`) }],
  ])("refuses %s", async (label, body) => {
    await expectJson(await redirectsCall(shopA, "DELETE", body), 400, label);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the forward answer", () => {
  it("is a 404 while the shop is unpublished or suspended", async () => {
    await expectJson(await put(shopA, [{ fromPath: "/hidden-old", toPath: "/" }]), 200, "put");
    await expectJson(await seo(shopA, "/hidden-old"), 200, "public shop");
    await env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(shopA.tenantId).run();
    await expectJson(await seo(shopA, "/hidden-old"), 404, "unpublished");
    await env.DB.prepare("UPDATE tenants SET published = 1, status = 'suspended' WHERE tenant_id = ?")
      .bind(shopA.tenantId)
      .run();
    await expectJson(await seo(shopA, "/hidden-old"), 404, "suspended");
    await env.DB.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").bind(shopA.tenantId).run();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the 0043 schema — the last fence", () => {
  const iso = "2026-09-28T00:00:00.000Z";

  async function insert(from: string, to: string, tenantId = shopB.tenantId) {
    return env.DB.prepare(
      `INSERT INTO redirects (tenant_id, from_path, to_path, created_at, created_by)
       VALUES (?, ?, ?, ?, 'test')`,
    )
      .bind(tenantId, from, to, iso)
      .run();
  }

  it("refuses a chain in either direction and a loop, by trigger", async () => {
    await insert("/fence-a", "/fence-b");
    await expect(insert("/fence-b", "/fence-c")).rejects.toThrow(/must not chain/);
    await expect(insert("/fence-z", "/fence-a")).rejects.toThrow(/must not chain/);
    await expect(
      env.DB.prepare("UPDATE redirects SET to_path = '/gammal/000' WHERE tenant_id = ? AND from_path = '/fence-a'")
        .bind(shopB.tenantId)
        .run(),
    ).rejects.toThrow(/must not chain/);
    // Another shop may use the same paths: the rule is per shop.
    await insert("/fence-b", "/fence-c", shopA.tenantId);
  });

  it.each([
    ["the root as a source", "/", "/x"],
    ["a trailing slash", "/a/", "/x"],
    ["a double slash", "/a//b", "/x"],
    ["a backslash", "/a\\b", "/x"],
    ["a dot segment", "/a/./b", "/x"],
    ["a parent segment", "/a/..", "/x"],
    ["a target with a host", "/fence-h", "//evil.test"],
    ["a target without a slash", "/fence-i", "https://evil.test"],
    ["a target with a parent segment", "/fence-j", "/../x"],
    ["a forward to itself", "/fence-k", "/fence-k"],
  ])("refuses %s", async (_label, from, to) => {
    await expect(insert(from, to)).rejects.toThrow();
  });

  it("refuses a change of tenant", async () => {
    await expect(
      env.DB.prepare("UPDATE redirects SET tenant_id = ? WHERE tenant_id = ? AND from_path = '/fence-a'")
        .bind(shopA.tenantId, shopB.tenantId)
        .run(),
    ).rejects.toThrow(/tenant_id is immutable/);
  });

  it("bumps catalog_version on every write", async () => {
    const version = async () =>
      (await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?").bind(shopB.tenantId).first<{ catalog_version: number }>())
        ?.catalog_version ?? 0;
    let before = await version();
    await insert("/bump-a", "/bump-target");
    expect(await version()).toBeGreaterThan(before);
    before = await version();
    await env.DB.prepare("UPDATE redirects SET to_path = '/bump-other' WHERE tenant_id = ? AND from_path = '/bump-a'")
      .bind(shopB.tenantId)
      .run();
    expect(await version()).toBeGreaterThan(before);
    before = await version();
    await env.DB.prepare("DELETE FROM redirects WHERE tenant_id = ? AND from_path = '/bump-a'").bind(shopB.tenantId).run();
    expect(await version()).toBeGreaterThan(before);
  });
});
