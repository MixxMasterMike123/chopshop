import { describe, expect, it } from "vitest";

import { cleanSegments, isAllowedAdminApiRequest } from "../admin/src/allowlist";
import { bareHttpsOrigin, readAdminConfig } from "../admin/src/env";
import type { AdminEnv } from "../admin/src/env";
import { apiResponseForBrowser, FORWARDED_HEADERS, forwardedAdminRequest } from "../admin/src/forward";
import { contentSecurityPolicy, withAdminHeaders } from "../admin/src/headers";
import { classifyAdminRequest } from "../admin/src/routing";

/**
 * CP5-WX — the admin Worker's pure rules: the allowlist, the request table,
 * the forwarded request and the headers. The glue is in admin-worker.test.ts.
 */

const ORIGIN = "https://admin.test.invalid";

describe("the allowlist: refused families", () => {
  const refused: [string, string][] = [
    // Storefront routes.
    ["GET", "/v1/storefront"],
    ["GET", "/v1/products"],
    ["GET", "/v1/products/p1"],
    ["POST", "/v1/checkout"],
    ["POST", "/v1/checkout/c1/payment"],
    ["GET", "/v1/orders/o1"],
    ["POST", "/v1/reports"],
    ["POST", "/v1/withdrawals"],
    ["GET", "/v1/seo"],
    ["GET", "/v1/sitemap"],
    ["GET", "/v1/collections"],
    ["GET", "/v1/pages/p"],
    ["GET", "/v1/legal"],
    // Webhooks, render, staging, health.
    ["POST", "/v1/webhooks/stripe"],
    ["POST", "/v1/webhooks/stripe-connect"],
    ["GET", "/v1/render/jobs"],
    ["POST", "/v1/render/jobs/j1/complete"],
    ["POST", "/v1/staging/fake-printer/orders"],
    ["GET", "/health"],
    ["GET", "/ready"],
    // The operator's one-time bootstrap.
    ["POST", "/v1/platform/bootstrap"],
    // A bare family with nothing under it, or a near miss.
    ["GET", "/v1/admin"],
    ["GET", "/v1/platform"],
    ["GET", "/v1/administrator/x"],
    ["GET", "/v1/admins/x"],
    ["GET", "/v2/admin/products"],
    ["GET", "/V1/admin/products"],
    ["GET", "/v1/Admin/products"],
    ["GET", "/v1/%61dmin/products"],
    ["GET", "/v1/admin%2fproducts"],
    // /v1/me: exact, GET only.
    ["POST", "/v1/me"],
    ["GET", "/v1/me/x"],
    ["GET", "/v1/me/"],
    // Auth: unmounted endpoints and wrong methods.
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/sign-out"],
    ["POST", "/api/auth/get-session"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/reset-password/short"],
    ["GET", "/api/auth/reset-password/abc.def.ghi.jkl.mno"],
    ["POST", "/api/auth/reset-password/abcdefghijklmnopqrst"],
    ["GET", "/api/auth/ok"],
    // Methods outside the families.
    ["OPTIONS", "/v1/admin/products"],
    ["TRACE", "/v1/admin/products"],
    ["CONNECT", "/v1/platform/tenants"],
    ["get", "/v1/admin/products"],
    // Nothing at all.
    ["GET", ""],
    ["GET", "/"],
    ["GET", "v1/admin/products"],
  ];

  for (const [method, path] of refused) {
    it(`${method} ${JSON.stringify(path)} is refused`, () => {
      expect(isAllowedAdminApiRequest(method, path)).toBe(false);
    });
  }
});

describe("the allowlist: unclean paths are refused before matching", () => {
  const unclean = [
    "/v1/admin//products",
    "/v1/admin/products/",
    "//v1/admin/products",
    "/v1/admin/products/%2e%2e",
    "/v1/admin/products/%2E",
    "/v1/admin/products/..",
    "/v1/admin/products/.",
    "/v1/admin/products/a%2fb",
    "/v1/admin/products/a%2Fb",
    "/v1/admin/products/a%5cb",
    "/v1/admin/products/a%5Cb",
    "/v1/admin/products/a\\b",
    "/v1/admin/products/a%00b",
    "/v1/admin/products/a%0ab",
    "/v1/admin/products/a%zz",
    "/v1/admin/products/a%e0%a4",
    "/v1/admin/products/a b",
    "/v1/admin/products/a\"b",
    "/v1/admin/products/a<b",
    `/v1/admin/products/${"a".repeat(513)}`,
    `/v1/admin/${"a/".repeat(1100)}x`,
  ];

  for (const path of unclean) {
    it(`${JSON.stringify(path.slice(0, 60))} is refused`, () => {
      expect(cleanSegments(path)).toBeNull();
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        expect(isAllowedAdminApiRequest(method, path)).toBe(false);
      }
    });
  }
});

describe("the allowlist: what passes", () => {
  const allowed: [string, string][] = [
    ["GET", "/v1/me"],
    ["GET", "/v1/admin/shop"],
    ["GET", "/v1/admin/products"],
    ["HEAD", "/v1/admin/products"],
    ["POST", "/v1/admin/products"],
    ["PATCH", "/v1/admin/products/p-1"],
    ["PUT", "/v1/admin/objects/o_1/content"],
    ["DELETE", "/v1/admin/discount-codes/dc%3A1"],
    ["POST", "/v1/admin/pod/artwork/a1/process"],
    ["GET", "/v1/admin/settings"],
    ["GET", "/v1/platform/tenants"],
    ["POST", "/v1/platform/tenants/t-1/acting-as"],
    ["DELETE", "/v1/platform/tenants/t-1/acting-as"],
    ["GET", "/v1/platform/users"],
    ["GET", "/v1/platform/bootstrap/x"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-out"],
    ["POST", "/api/auth/request-password-reset"],
    ["POST", "/api/auth/reset-password"],
    ["GET", "/api/auth/reset-password/abcdefghijklmnopqrstuvwx"],
  ];

  for (const [method, path] of allowed) {
    it(`${method} ${path} passes`, () => {
      expect(isAllowedAdminApiRequest(method, path)).toBe(true);
    });
  }
});

describe("classifyAdminRequest", () => {
  it("forwards an allowed /_api path with the prefix stripped", () => {
    expect(classifyAdminRequest("GET", "/_api/v1/me")).toEqual({ apiPath: "/v1/me", kind: "api" });
    expect(classifyAdminRequest("POST", "/_api/api/auth/sign-in/email")).toEqual({
      apiPath: "/api/auth/sign-in/email",
      kind: "api",
    });
  });

  it("refuses everything else under /_api, whatever the method", () => {
    for (const path of ["/_api", "/_api/", "/_api/v1/storefront", "/_api/health", "/_api/_api/v1/me"]) {
      expect(classifyAdminRequest("GET", path)).toEqual({ kind: "api_refused" });
    }
    expect(classifyAdminRequest("PATCH", "/_api/v1/me")).toEqual({ kind: "api_refused" });
  });

  it("does not treat a look-alike prefix as /_api", () => {
    expect(classifyAdminRequest("GET", "/_apix/v1/me")).toEqual({ kind: "shell" });
    expect(classifyAdminRequest("POST", "/_apix/v1/me")).toEqual({ kind: "not_found" });
  });

  it("serves the shell for every address of both trees", () => {
    for (const path of ["/", "/login", "/reset-password", "/admin", "/admin/products/p1", "/platform", "/platform/shops/s1", "/index.html", "/x/y.z"]) {
      expect(classifyAdminRequest("GET", path)).toEqual({ kind: "shell" });
      expect(classifyAdminRequest("HEAD", path)).toEqual({ kind: "shell" });
    }
  });

  it("serves built files from the build, never the shell", () => {
    for (const path of ["/assets/index-abc.js", "/assets/x/y.css", "/images/logo.svg", "/favicon.ico", "/manifest.json"]) {
      expect(classifyAdminRequest("GET", path)).toEqual({ kind: "static" });
    }
  });

  it("answers robots.txt itself", () => {
    expect(classifyAdminRequest("GET", "/robots.txt")).toEqual({ kind: "robots" });
  });

  it("refuses a state change outside /_api", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(classifyAdminRequest(method, "/login")).toEqual({ kind: "not_found" });
      expect(classifyAdminRequest(method, "/assets/a.js")).toEqual({ kind: "not_found" });
    }
  });
});

describe("the configuration", () => {
  it("takes a bare https origin only", () => {
    expect(bareHttpsOrigin(ORIGIN)).toBe(ORIGIN);
    for (const bad of [undefined, "", "http://admin.test.invalid", `${ORIGIN}/`, `${ORIGIN}/x`, `${ORIGIN}?a`, "https://u:p@admin.test.invalid", "https://ADMIN.test.invalid", "nonsense"]) {
      expect(bareHttpsOrigin(bad)).toBeNull();
    }
  });

  it("needs the admin origin and tolerates a missing image origin", () => {
    const base = { API: { fetch: async () => new Response() }, ASSETS: { fetch: async () => new Response() } };
    expect(readAdminConfig({ ...base, ADMIN_ORIGIN: undefined, PUBLIC_OBJECT_BASE_URL: undefined } as AdminEnv)).toBeNull();
    expect(readAdminConfig({ ...base, ADMIN_ORIGIN: ORIGIN, PUBLIC_OBJECT_BASE_URL: "nope" } as AdminEnv)).toEqual({
      adminHost: "admin.test.invalid",
      adminOrigin: ORIGIN,
      publicObjectOrigin: null,
    });
  });
});

describe("forwardedAdminRequest", () => {
  function browserRequest(method: string, headers: Record<string, string>, body?: string): Request {
    return new Request(`${ORIGIN}/_api/v1/admin/products?x=1`, { body, headers, method });
  }

  it("forwards exactly the named headers and nothing a browser could forge", () => {
    const forwarded = forwardedAdminRequest(
      browserRequest(
        "POST",
        {
          accept: "application/json",
          authorization: "Bearer stolen",
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
          cookie: "__Secure-better-auth.session_token=abc",
          "idempotency-key": "k-1",
          "if-none-match": '"e1"',
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "stripe-signature": "t=1,v1=x",
          "user-agent": "Browser/1",
          "x-bootstrap-token": "a".repeat(40),
          "x-forwarded-for": "198.51.100.1",
          "x-forwarded-host": "evil.test",
          "x-internal-surface": "internal",
          "x-shop-id": "shop-a",
          "x-storefront-preview": "v1.1.x",
          "X-Tenant-Id": "shop-b",
          "x-tenant-host": "evil.test",
        },
        "{}",
      ),
      `${ORIGIN}/v1/admin/products?x=1`,
    );

    expect(forwarded.url).toBe(`${ORIGIN}/v1/admin/products?x=1`);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.redirect).toBe("manual");
    const names = [...forwarded.headers.keys()].sort();
    expect(names).toEqual(
      [
        "accept",
        "cf-connecting-ip",
        "content-type",
        "cookie",
        "idempotency-key",
        "if-none-match",
        "origin",
        "sec-fetch-site",
        "user-agent",
        "x-shop-id",
      ].sort(),
    );
    expect(forwarded.headers.get("cookie")).toBe("__Secure-better-auth.session_token=abc");
    expect(forwarded.headers.get("origin")).toBe(ORIGIN);
    expect(forwarded.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    for (const name of names) {
      expect(FORWARDED_HEADERS).toContain(name);
      expect(name.startsWith("x-tenant-")).toBe(false);
    }
  });

  it("sends a body only when there is one", async () => {
    const withBody = forwardedAdminRequest(
      browserRequest("PATCH", { "content-length": "7", "content-type": "application/json" }, '{"a":1}'),
      `${ORIGIN}/v1/admin/products/p`,
    );
    expect(await withBody.text()).toBe('{"a":1}');
    expect(withBody.headers.get("content-length")).toBe("7");

    const declaredEmpty = forwardedAdminRequest(
      browserRequest("POST", { "content-length": "0" }, ""),
      `${ORIGIN}/v1/admin/products/p/publish`,
    );
    expect(declaredEmpty.body).toBeNull();
    expect(declaredEmpty.headers.has("content-length")).toBe(false);

    const read = forwardedAdminRequest(
      browserRequest("GET", { "content-length": "3" }),
      `${ORIGIN}/v1/admin/products`,
    );
    expect(read.body).toBeNull();
    expect(read.headers.has("content-length")).toBe(false);
  });
});

describe("apiResponseForBrowser", () => {
  it("passes every Set-Cookie and every other header back unchanged", () => {
    const headers = new Headers({ "cache-control": "no-store", etag: '"v1"', "retry-after": "3" });
    headers.append("set-cookie", "__Secure-better-auth.session_token=a; Path=/; HttpOnly; Secure; SameSite=Lax");
    headers.append("set-cookie", "__Secure-better-auth.dont_remember=; Max-Age=0; Path=/");
    headers.append("set-cookie", "third=3; Path=/");
    const response = apiResponseForBrowser(new Response("{}", { headers, status: 201 }));

    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([
      "__Secure-better-auth.session_token=a; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Secure-better-auth.dont_remember=; Max-Age=0; Path=/",
      "third=3; Path=/",
    ]);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(response.headers.get("retry-after")).toBe("3");
  });

  it("builds a null-body status without a body", () => {
    expect(apiResponseForBrowser(new Response(null, { status: 304 })).status).toBe(304);
    expect(apiResponseForBrowser(new Response(null, { status: 204 })).body).toBeNull();
  });
});

describe("the headers", () => {
  const PUBLIC = "https://pub.test.invalid";

  it("enforces the policy on HTML", () => {
    const response = withAdminHeaders(
      new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      PUBLIC,
    );
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(response.headers.has("content-security-policy-report-only")).toBe(false);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain(`img-src 'self' data: blob: ${PUBLIC} https://*.r2.cloudflarestorage.com`);
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(policy).toContain("connect-src 'self' https://*.r2.cloudflarestorage.com");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("puts no policy on JSON, but the rest of the headers", () => {
    const response = withAdminHeaders(Response.json({ a: 1 }), PUBLIC);
    expect(response.headers.has("content-security-policy")).toBe(false);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("allows no public image origin when none is configured", () => {
    expect(contentSecurityPolicy(null)).toContain("img-src 'self' data: blob: https://*.r2.cloudflarestorage.com;");
  });
});
