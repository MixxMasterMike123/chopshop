import { describe, expect, it } from "vitest";

import { SHOP_SEGMENT_PATTERN as API_SHOP_SEGMENT_PATTERN } from "../src/tenancy/shop-hostname";
import {
  isAllowedStorefrontApiRequest,
  isIdSegment,
  STOREFRONT_API_ROUTES,
} from "../web/src/api-allowlist";
import { bareHttpsOrigin, readWebConfig, type WebEnv } from "../web/src/env";
import {
  apiResponseForBrowser,
  forwardedApiRequest,
  workerApiRequest,
} from "../web/src/forward";
import { contentSecurityPolicy, securityHeaders } from "../web/src/headers";
import { classifyRequest } from "../web/src/routing";
import {
  absolutizeJsonLd,
  parseSeoAnswer,
  redirectLocation,
  SEO_DEADLINE_MS,
  shopUrl,
  withDeadline,
} from "../web/src/seo";
import {
  parseShopSegment,
  SHOP_SEGMENT_PATTERN,
  TENANCY_RESERVED_SEGMENTS,
} from "../web/src/shop-segment";
import { buildRobotsTxt, buildSitemapXml, parseSitemapPage } from "../web/src/sitemap";

/**
 * CP4-E — the web Worker's decisions, as pure functions (request in, decision
 * out). The glue that calls them is covered end to end in web-worker.test.ts.
 */

const ORIGIN = "https://web.test.invalid";
const SHOP = { root: "/sillmans", shop: "sillmans" };
const OWN = { root: "", shop: null };

describe("the shop segment", () => {
  it("has the API's shape, character for character", () => {
    expect(SHOP_SEGMENT_PATTERN.source).toBe(API_SHOP_SEGMENT_PATTERN.source);
    expect(SHOP_SEGMENT_PATTERN.flags).toBe(API_SHOP_SEGMENT_PATTERN.flags);
  });

  it("reserves exactly the non-shop first segments of src/config/tenancy.js", async () => {
    // A runtime specifier: tenancy.js is plain JS outside this TypeScript project.
    const specifier = new URL("../../src/config/tenancy.js", import.meta.url).href;
    const tenancy: unknown = await import(/* @vite-ignore */ specifier);
    const segments = (tenancy as { NON_SHOP_FIRST_SEGMENTS: Set<string> }).NON_SHOP_FIRST_SEGMENTS;

    expect([...segments].sort()).toEqual([...TENANCY_RESERVED_SEGMENTS].sort());
  });

  it("takes a well-formed shop id", () => {
    expect(parseShopSegment("sillmans")).toBe("sillmans");
    expect(parseShopSegment("melodie-mc")).toBe("melodie-mc");
    expect(parseShopSegment("a")).toBe("a");
    expect(parseShopSegment(`a${"b".repeat(62)}`)).toBe(`a${"b".repeat(62)}`);
  });

  it.each([
    ...TENANCY_RESERVED_SEGMENTS,
    "assets",
    "images",
    "_api",
    "",
    "Sillmans",
    "-shop",
    "shop_1",
    "sill%6Dans",
    "..",
    ".",
    "robots.txt",
    `a${"b".repeat(63)}`,
    "shöp",
  ])("refuses %j", (segment) => {
    expect(parseShopSegment(segment)).toBeNull();
  });
});

describe("the API allowlist", () => {
  it.each([
    ["GET", "/v1/storefront"],
    ["GET", "/v1/storefront/pod-previews/prod-1/art-1"],
    ["GET", "/v1/products"],
    ["GET", "/v1/products/prod-1"],
    ["GET", "/v1/products/%C3%A5ngra-t-shirt"],
    ["GET", "/v1/collections"],
    ["GET", "/v1/collections/sommar"],
    ["GET", "/v1/pages"],
    ["GET", "/v1/pages/om-oss"],
    ["GET", "/v1/legal"],
    ["GET", "/v1/legal/kopvillkor"],
    ["POST", "/v1/checkout"],
    ["POST", "/v1/checkout/4f6e2a9c-1b3d-4e5f-8a7b-9c0d1e2f3a4b/payment"],
    ["POST", "/v1/checkout/4f6e2a9c-1b3d-4e5f-8a7b-9c0d1e2f3a4b/receipt"],
    ["POST", "/v1/discount-codes/preview"],
    ["GET", "/v1/orders/4f6e2a9c-1b3d-4e5f-8a7b-9c0d1e2f3a4b"],
    ["POST", "/v1/reports"],
    ["POST", "/v1/withdrawals"],
  ])("passes %s %s", (method, path) => {
    expect(isAllowedStorefrontApiRequest(method, path)).toBe(true);
  });

  it.each([
    // The surfaces a browser must never reach through the storefront.
    ["GET", "/v1/admin/products"],
    ["POST", "/v1/admin/products"],
    ["GET", "/v1/admin/settings"],
    ["GET", "/v1/platform/tenants"],
    ["POST", "/v1/platform/bootstrap"],
    ["GET", "/v1/render/jobs"],
    ["POST", "/v1/webhooks/stripe"],
    ["GET", "/v1/staging/fake-printer/jobs"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/health"],
    ["GET", "/ready"],
    // Worker-only reads.
    ["GET", "/v1/seo"],
    ["GET", "/v1/sitemap"],
    // Wrong methods on allowed paths.
    ["POST", "/v1/storefront"],
    ["HEAD", "/v1/products"],
    ["DELETE", "/v1/products/prod-1"],
    ["PUT", "/v1/checkout"],
    ["GET", "/v1/checkout"],
    ["GET", "/v1/discount-codes/preview"],
    ["POST", "/v1/discount-codes"],
    ["POST", "/v1/discount-codes/preview/x"],
    ["GET", "/v1/checkout/x/payment"],
    ["POST", "/v1/orders/x"],
    ["GET", "/v1/withdrawals"],
    ["POST", "/v1/withdrawals/x"],
    ["OPTIONS", "/v1/storefront"],
    // Spellings of an allowed path that are not that path.
    ["GET", "/v1/%70roducts"],
    ["GET", "/v1/Products"],
    ["GET", "/V1/products"],
    ["GET", "/v1/products/"],
    ["GET", "//v1/products"],
    ["GET", "/v1//products"],
    ["GET", "/v1/products;x"],
    ["GET", "v1/products"],
    ["GET", ""],
    // Id segments that are not ids.
    ["GET", "/v1/products/%2e%2e"],
    ["GET", "/v1/products/%2E"],
    ["GET", "/v1/products/.."],
    ["GET", "/v1/products/a%2Fb"],
    ["GET", "/v1/products/a%5Cb"],
    ["GET", "/v1/products/a%00b"],
    ["GET", "/v1/products/%C3"],
    ["GET", "/v1/products/a b"],
    ["GET", "/v1/products/a:b"],
    ["GET", `/v1/products/${"a".repeat(513)}`],
    // A path that continues past an allowed route.
    ["GET", "/v1/products/prod-1/admin"],
    ["POST", "/v1/checkout/x/payment/extra"],
    ["GET", "/v1/storefront/pod-previews/p"],
  ])("refuses %s %j", (method, path) => {
    expect(isAllowedStorefrontApiRequest(method, path)).toBe(false);
  });

  it("names no route under a refused surface", () => {
    const refused = ["admin", "platform", "render", "webhooks", "staging", "seo", "sitemap"];
    for (const route of STOREFRONT_API_ROUTES) {
      expect(route.segments[0]).toBe("v1");
      expect(refused).not.toContain(route.segments[1]);
    }
  });

  it("decodes an id once and refuses what that decoding yields", () => {
    expect(isIdSegment("abc-_.~")).toBe(true);
    expect(isIdSegment("%25")).toBe(true);
    expect(isIdSegment("%252F")).toBe(true);
    expect(isIdSegment("%2F")).toBe(false);
    expect(isIdSegment("")).toBe(false);
  });
});

describe("classifyRequest", () => {
  describe("on the shared host", () => {
    it.each([
      ["GET", "/_api/sillmans/v1/storefront", { apiPath: "/v1/storefront", kind: "api", site: SHOP }],
      ["POST", "/_api/sillmans/v1/checkout", { apiPath: "/v1/checkout", kind: "api", site: SHOP }],
      ["GET", "/_api/sillmans/v1/admin/products", { kind: "api_refused" }],
      ["GET", "/_api/sillmans/v1/platform/tenants", { kind: "api_refused" }],
      ["GET", "/_api/sillmans/api/auth/get-session", { kind: "api_refused" }],
      ["GET", "/_api/admin/v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api/Sillmans/v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api/sill%6Dans/v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api/v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api//v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api/sillmans", { kind: "api_refused" }],
      ["GET", "/_api", { kind: "api_refused" }],
      ["GET", "/robots.txt", { kind: "robots" }],
      ["GET", "/sillmans/sitemap.xml", { kind: "sitemap", site: SHOP }],
      ["GET", "/assets/index-abc123.js", { kind: "static", orPage: null }],
      ["GET", "/images/logo.svg", { kind: "static", orPage: null }],
      ["GET", "/favicon.ico", { kind: "static", orPage: null }],
      ["GET", "/sillmans", { kind: "page", relativePath: "/", site: SHOP }],
      ["GET", "/sillmans/", { kind: "page", relativePath: "/", site: SHOP }],
      ["GET", "/sillmans/product/t-shirt", { kind: "page", relativePath: "/product/t-shirt", site: SHOP }],
      ["HEAD", "/sillmans/cart", { kind: "page", relativePath: "/cart", site: SHOP }],
      ["GET", "/sillmans/om-oss", { kind: "page", relativePath: "/om-oss", site: SHOP }],
      ["GET", "/", { kind: "no_shop" }],
      ["GET", "/admin", { kind: "no_shop" }],
      ["GET", "/login", { kind: "no_shop" }],
      ["GET", "/index.html", { kind: "no_shop" }],
      ["GET", "/Sillmans/cart", { kind: "no_shop" }],
      ["POST", "/sillmans/cart", { kind: "not_found" }],
      ["DELETE", "/sillmans", { kind: "not_found" }],
    ])("%s %s", (method, path, expected) => {
      expect(classifyRequest(method, path, true)).toEqual(expected);
    });
  });

  describe("on a shop's own domain", () => {
    it.each([
      ["GET", "/_api/v1/storefront", { apiPath: "/v1/storefront", kind: "api", site: OWN }],
      ["GET", "/_api/v1/orders/abc", { apiPath: "/v1/orders/abc", kind: "api", site: OWN }],
      ["GET", "/_api/sillmans/v1/storefront", { kind: "api_refused" }],
      ["GET", "/_api/v1/admin/settings", { kind: "api_refused" }],
      ["GET", "/sitemap.xml", { kind: "sitemap", site: OWN }],
      ["GET", "/robots.txt", { kind: "robots" }],
      ["GET", "/", { kind: "page", relativePath: "/", site: OWN }],
      ["GET", "/product/t-shirt", { kind: "page", relativePath: "/product/t-shirt", site: OWN }],
      ["GET", "/admin", { kind: "page", relativePath: "/admin", site: OWN }],
      ["GET", "/manifest.json", { kind: "static", orPage: { relativePath: "/manifest.json", site: OWN } }],
      ["GET", "/index.html", { kind: "page", relativePath: "/index.html", site: OWN }],
      ["PUT", "/cart", { kind: "not_found" }],
    ])("%s %s", (method, path, expected) => {
      expect(classifyRequest(method, path, false)).toEqual(expected);
    });
  });
});

describe("the forwarded request", () => {
  it("drops every X-Tenant-* header and keeps everything else", async () => {
    const forwarded = forwardedApiRequest(
      new Request("https://web.test.invalid/_api/sillmans/v1/checkout", {
        body: '{"a":1}',
        headers: {
          authorization: "Bearer receipt",
          "cf-connecting-ip": "198.51.100.7",
          "content-type": "application/json",
          "if-none-match": '"12"',
          "X-Tenant-Id": "other",
          "x-tenant-host": "other.test",
          "X-TENANT-ANYTHING": "x",
          "x-tenantid": "kept",
        },
        method: "POST",
      }),
      "https://web.test.invalid/v1/checkout",
    );

    expect(forwarded.url).toBe("https://web.test.invalid/v1/checkout");
    expect(forwarded.method).toBe("POST");
    expect([...forwarded.headers.keys()].filter((name) => name.startsWith("x-tenant-"))).toEqual([]);
    expect(forwarded.headers.get("x-tenantid")).toBe("kept");
    expect(forwarded.headers.get("authorization")).toBe("Bearer receipt");
    expect(forwarded.headers.get("cf-connecting-ip")).toBe("198.51.100.7");
    expect(forwarded.headers.get("if-none-match")).toBe('"12"');
    await expect(forwarded.text()).resolves.toBe('{"a":1}');
  });

  it("forwards no cookie, and keeps the receipt's bearer token", () => {
    const forwarded = forwardedApiRequest(
      new Request("https://web.test.invalid/_api/sillmans/v1/orders/o1", {
        headers: { authorization: "Bearer receipt", cookie: "session=abc; other=1" },
      }),
      "https://web.test.invalid/v1/orders/o1",
    );

    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBe("Bearer receipt");
  });

  it("sends a POST that declares no body with no body at all", () => {
    const forwarded = forwardedApiRequest(
      new Request("https://web.test.invalid/_api/sillmans/v1/checkout/x/payment", {
        body: "",
        headers: { "content-length": "0" },
        method: "POST",
      }),
      "https://web.test.invalid/v1/checkout/x/payment",
    );

    expect(forwarded.body).toBeNull();
    expect(forwarded.headers.get("content-length")).toBeNull();
  });

  it("builds the Worker's own reads with the visitor's address and nothing of the browser", () => {
    const request = workerApiRequest("https://web.test.invalid/v1/seo?path=%2F", "203.0.113.9");
    expect(request.method).toBe("GET");
    expect(request.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect([...request.headers.keys()].sort()).toEqual(["accept", "cf-connecting-ip"]);
  });

  it("passes the API's answer on without its cookies", async () => {
    const answer = apiResponseForBrowser(
      new Response('{"ok":true}', {
        headers: {
          "cache-control": "no-cache",
          etag: '"7"',
          "set-cookie": "session=x",
        },
        status: 200,
      }),
    );
    expect(answer.headers.get("etag")).toBe('"7"');
    expect(answer.headers.get("cache-control")).toBe("no-cache");
    expect(answer.headers.get("set-cookie")).toBeNull();
    await expect(answer.text()).resolves.toBe('{"ok":true}');

    const notModified = apiResponseForBrowser(new Response(null, { headers: { etag: '"7"' }, status: 304 }));
    expect(notModified.status).toBe(304);
  });
});

describe("addresses under the shop's root", () => {
  it("makes a relative path absolute under the shop's root", () => {
    expect(shopUrl(ORIGIN, SHOP, "/product/t-shirt")?.toString()).toBe(
      "https://web.test.invalid/sillmans/product/t-shirt",
    );
    expect(shopUrl(ORIGIN, SHOP, "/")?.toString()).toBe("https://web.test.invalid/sillmans/");
    expect(shopUrl("https://shop.example.test", OWN, "/product/å")?.toString()).toBe(
      "https://shop.example.test/product/%C3%A5",
    );
  });

  it.each([
    ["an absolute address", "https://evil.test/x"],
    ["a protocol-relative address", "//evil.test/x"],
    ["a backslash address", "/\\evil.test/x"],
    ["a backslash inside", "/a\\b"],
    ["a scheme", "javascript:alert(1)"],
    ["no leading slash", "product/x"],
    ["an empty path", ""],
    ["whitespace", "/a b"],
    ["a control character", "/a\u0000b"],
    ["a line break", "/a\nLocation: x"],
    ["a dot-segment escape", "/../other-shop/x"],
    ["an encoded dot-segment escape", "/%2e%2e/other-shop"],
    ["a deeper escape", "/a/../../other-shop"],
  ])("refuses %s", (_label, relative) => {
    expect(shopUrl(ORIGIN, SHOP, relative)).toBeNull();
    expect(redirectLocation(ORIGIN, SHOP, relative)).toBeNull();
  });

  it("keeps a redirect on the shop's own root, as a path", () => {
    expect(redirectLocation(ORIGIN, SHOP, "/product/ny?x=1#y")).toBe("/sillmans/product/ny?x=1#y");
    expect(redirectLocation(ORIGIN, OWN, "/product/ny")).toBe("/product/ny");
    expect(redirectLocation(ORIGIN, SHOP, "/a/../b")).toBe("/sillmans/b");
    expect(redirectLocation(ORIGIN, OWN, "/%2e%2e/x")).toBe("/x");
  });
});

describe("the SEO answer", () => {
  it("has a deadline of 1.5 s", () => {
    expect(SEO_DEADLINE_MS).toBe(1_500);
  });

  it("reads a forward", () => {
    expect(parseSeoAnswer({ redirect: { status: 301, to: "/product/new" } })).toEqual({
      kind: "redirect",
      to: "/product/new",
    });
  });

  it("reads a page", () => {
    expect(
      parseSeoAnswer({
        page: {
          bodyHtml: "<h1>T</h1>",
          canonicalPath: "/product/t",
          description: "D",
          image: { height: 600, url: "https://img.test/x.jpg", width: 800 },
          jsonLd: { "@type": "Product" },
          robots: "index,follow",
          title: "T",
        },
      }),
    ).toEqual({
      kind: "page",
      page: {
        bodyHtml: "<h1>T</h1>",
        canonicalPath: "/product/t",
        description: "D",
        image: { height: 600, url: "https://img.test/x.jpg", width: 800 },
        jsonLd: { "@type": "Product" },
        robots: "index,follow",
        title: "T",
      },
    });
  });

  it.each([
    ["no object", null],
    ["an array", []],
    ["neither key", { other: 1 }],
    ["a 302", { redirect: { status: 302, to: "/x" } }],
    ["a forward without a target", { redirect: { status: 301 } }],
    ["a page without a title", { page: { description: "x" } }],
    ["a title that is not text", { page: { title: 5 } }],
    ["a title too long", { page: { title: "t".repeat(301) } }],
    ["a description that is not text", { page: { description: 1, title: "t" } }],
    ["a body that is not text", { page: { bodyHtml: {}, title: "t" } }],
  ])("is no answer for %s", (_label, body) => {
    expect(parseSeoAnswer(body)).toBeNull();
  });

  it("makes every @relative address absolute and drops one that leaves the root", () => {
    const resolve = (relative: string): string | null =>
      shopUrl(ORIGIN, SHOP, relative)?.toString() ?? null;
    expect(
      absolutizeJsonLd(
        {
          "@context": "https://schema.org",
          "@type": "Product",
          offers: [{ url: { "@relative": "/product/t" } }],
          url: { "@relative": "/product/t" },
          escape: { "@relative": "/../other/x" },
          notRelative: { "@relative": "/x", extra: 1 },
        },
        resolve,
      ),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      escape: null,
      // Only an object whose ONE key is @relative is an address.
      notRelative: { "@relative": "/x", extra: 1 },
      offers: [{ url: "https://web.test.invalid/sillmans/product/t" }],
      url: "https://web.test.invalid/sillmans/product/t",
    });
  });

  it("drops JSON-LD nested past 32 levels", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 40; i += 1) {
      deep = { a: deep };
    }
    expect(absolutizeJsonLd(deep, () => null)).toBeNull();
  });

  it("answers timeout when the call is slower than the deadline", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withDeadline(never, 5)).resolves.toBe("timeout");
    await expect(withDeadline(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
  });
});

describe("sitemap and robots", () => {
  it("reads a sitemap answer and keeps only well-formed entries", () => {
    expect(
      parseSitemapPage({
        entries: [
          { lastModified: "2026-09-28T10:00:00.000Z", path: "/product/a" },
          { lastModified: "yesterday", path: "/b" },
          { path: 5 },
          "x",
        ],
        nextCursor: "c1",
      }),
    ).toEqual({
      entries: [
        { lastModified: "2026-09-28T10:00:00.000Z", path: "/product/a" },
        { lastModified: null, path: "/b" },
      ],
      nextCursor: "c1",
    });
    expect(parseSitemapPage({ nope: [] })).toBeNull();
  });

  it("writes absolute, escaped addresses and leaves out any that leave the root", () => {
    const xml = buildSitemapXml(
      [
        { lastModified: "2026-09-28", path: "/product/a&b" },
        { lastModified: null, path: "/../other" },
        { lastModified: null, path: "//evil.test/x" },
      ],
      (relative) => shopUrl(ORIGIN, SHOP, relative)?.toString() ?? null,
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "<url><loc>https://web.test.invalid/sillmans/product/a&amp;b</loc><lastmod>2026-09-28</lastmod></url>" +
        "</urlset>\n",
    );
  });

  it("names the sitemap on a shop's own domain and none on the shared host", () => {
    expect(buildRobotsTxt("https://shop.example.test/sitemap.xml")).toBe(
      "User-agent: *\nAllow: /\nDisallow: /_api/\nSitemap: https://shop.example.test/sitemap.xml\n",
    );
    expect(buildRobotsTxt(null)).toBe("User-agent: *\nAllow: /\nDisallow: /_api/\n");
  });
});

describe("configuration and headers", () => {
  const env = (vars: Partial<WebEnv>): WebEnv => ({
    API: { fetch: async () => new Response(null), fetchForShop: async () => new Response(null) },
    ASSETS: { fetch: async () => new Response(null) },
    PUBLIC_OBJECT_BASE_URL: undefined,
    WEB_ORIGIN: undefined,
    ...vars,
  });

  it("accepts only a bare https origin", () => {
    expect(bareHttpsOrigin("https://web.test.invalid")).toBe("https://web.test.invalid");
    for (const value of [
      "http://web.test.invalid",
      "https://web.test.invalid/",
      "https://web.test.invalid/x",
      "https://user@web.test.invalid",
      "https://web.test.invalid:443",
      "https://WEB.test.invalid",
      "web.test.invalid",
      "",
      undefined,
    ]) {
      expect(bareHttpsOrigin(value), String(value)).toBeNull();
    }
  });

  it("fails closed without a valid web origin", () => {
    expect(readWebConfig(env({}))).toBeNull();
    expect(readWebConfig(env({ WEB_ORIGIN: "https://web.test.invalid/" }))).toBeNull();
    expect(
      readWebConfig(env({ PUBLIC_OBJECT_BASE_URL: "https://pub.test.invalid", WEB_ORIGIN: ORIGIN })),
    ).toEqual({
      publicObjectOrigin: "https://pub.test.invalid",
      webHost: "web.test.invalid",
      webOrigin: ORIGIN,
    });
  });

  it("sets the storefront target's security headers and a report-only policy", () => {
    const headers = securityHeaders("https://pub.test.invalid");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(headers["Content-Security-Policy-Report-Only"]).toContain(
      "img-src 'self' data: blob: https://pub.test.invalid;",
    );
    expect(Object.keys(headers)).not.toContain("Content-Security-Policy");
  });

  it("allows no image origin but its own without a public object origin, and no Firebase endpoint", () => {
    const policy = contentSecurityPolicy(null);
    expect(policy).toContain("img-src 'self' data: blob:;");
    for (const gone of ["*.googleapis.com", "cloudfunctions.net", "run.app", "www.gstatic.com", "https:;", "firebase"]) {
      expect(policy, gone).not.toContain(gone);
    }
  });
});
