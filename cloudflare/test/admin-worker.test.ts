import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { AdminEnv, ApiBinding, AssetsBinding } from "../admin/src/env";
import { handleRequest } from "../admin/src/index";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth/create-auth";
import { stripTenantHeaders } from "../src/lib/tenant-headers";
import { switchStatement } from "./discount-fixtures";
import { acceptTermsStatement } from "./legal-fixtures";

/**
 * CP5-WX — the admin Worker end to end: `handleRequest` with a fake asset
 * store and either a spy standing in for the API (to see exactly what the
 * Worker sends) or the REAL API app on the `internal` surface (to prove the
 * session works through the proxy: Better Auth's sign-in on the admin host,
 * its cookie, and an admin route's own same-origin check).
 */

const ADMIN_ORIGIN = "https://admin.wx.test.invalid";
const ADMIN_HOST = "admin.wx.test.invalid";
const PUBLIC_ORIGIN = "https://pub.wx.test.invalid";
// The API's own origin, as vitest.config.ts pins AUTH_BASE_URL.
const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";
const TENANT = "tenant-wx-a";
const EMAIL = "admin@wx.test";
const PASSWORD = "test-password-long-enough";
const NOW = 1_787_200_000_000;

const SHELL = `<!doctype html><html lang="sv"><head><meta charset="UTF-8" /><title>Admin</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;

const ASSET_FILES: Record<string, { body: string; type: string }> = {
  "/assets/index-abc.js": { body: "console.log(1)", type: "text/javascript" },
  "/favicon.ico": { body: "ico", type: "image/x-icon" },
  "/index.html": { body: SHELL, type: "text/html" },
};

function assets(): AssetsBinding & { requested: string[] } {
  const requested: string[] = [];
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const file = ASSET_FILES[path];
      return file === undefined
        ? new Response("missing", { status: 404 })
        : new Response(file.body, { headers: { "content-type": file.type, etag: '"a1"' } });
    },
    requested,
  };
}

function spyApi(answer: (request: Request) => Promise<Response> | Response = () => Response.json({ ok: true })): {
  api: ApiBinding;
  calls: Request[];
} {
  const calls: Request[] = [];
  return {
    api: {
      fetch: async (request) => {
        calls.push(request);
        return answer(request);
      },
    },
    calls,
  };
}

function adminEnv(api: ApiBinding, vars: Partial<AdminEnv> = {}): AdminEnv {
  return {
    ADMIN_ORIGIN,
    API: api,
    ASSETS: assets(),
    PUBLIC_OBJECT_BASE_URL: PUBLIC_ORIGIN,
    ...vars,
  };
}

// ── the real API behind the proxy ──────────────────────────────────────────

const internalApp = createApp({ surface: "internal" });

/**
 * The API's `Internal` entrypoint as the admin Worker reaches it, with the
 * API's vars as the reviewer wiring sets them: the admin origin listed in
 * AUTH_TRUSTED_ORIGINS. Everything else is this pool's env.
 */
function apiTrusting(...extraOrigins: string[]): ApiBinding {
  const trusted: Env = {
    ...env,
    AUTH_TRUSTED_ORIGINS: [env.AUTH_TRUSTED_ORIGINS, ...extraOrigins].join(","),
  };
  return {
    fetch: async (request) => internalApp.fetch(stripTenantHeaders(request), trusted),
  };
}

/** The real `Internal` entrypoint with this pool's vars unchanged (admin origin NOT trusted). */
const realInternal: ApiBinding = {
  fetch: (request) => exports.Internal.fetch(request),
};

function browser(
  method: string,
  path: string,
  options: { body?: BodyInit; cookie?: string; headers?: Record<string, string>; origin?: string | null } = {},
): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  const origin = options.origin === undefined ? (method === "GET" ? null : ADMIN_ORIGIN) : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (typeof options.body === "string") headers.set("content-type", "application/json");
  headers.set("cf-connecting-ip", "203.0.113.50");
  return new Request(`${ADMIN_ORIGIN}${path}`, { body: options.body, headers, method });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

let userId = "";

beforeAll(async () => {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signUp = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: EMAIL, name: EMAIL, password: PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  expect(signUp.status).toBe(200);
  userId = (await signUp.json<{ user: { id: string } }>()).user.id;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
       VALUES (?, 'tenant_admin', 'active', ?, ?)`,
    ).bind(userId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenants (tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at)
       VALUES (?, 'active', 'WX Shop', 'sv-SE', 'SEK', ?, ?)`,
    ).bind(TENANT, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_memberships (membership_id, tenant_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    ).bind(`membership-wx-${userId}`, TENANT, userId, NOW, NOW),
    acceptTermsStatement(env.DB, TENANT),
    // The admin write below is a discount code, whose routes follow the
    // shop's opt-in switch (CP8-DC DC2, DC14).
    switchStatement(TENANT, true),
  ]);
});

async function signInThroughProxy(api: ApiBinding): Promise<Response> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  return handleRequest(
    browser("POST", "/_api/api/auth/sign-in/email", {
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" },
    }),
    adminEnv(api),
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("configuration and host", () => {
  it("answers 503 without a valid admin origin, and calls nothing", async () => {
    for (const bad of [undefined, "http://admin.wx.test.invalid", `${ADMIN_ORIGIN}/`]) {
      const spy = spyApi();
      const response = await handleRequest(browser("GET", "/_api/v1/me"), adminEnv(spy.api, { ADMIN_ORIGIN: bad }));
      expect(response.status).toBe(503);
      expect(spy.calls).toHaveLength(0);
    }
  });

  it("answers nothing on another host", async () => {
    const spy = spyApi();
    for (const url of ["https://evil.test/_api/v1/me", "https://evil.test/login"]) {
      const response = await handleRequest(new Request(url), adminEnv(spy.api));
      expect(response.status).toBe(404);
    }
    expect(spy.calls).toHaveLength(0);
  });

  it("sends a plain-http navigation to https and refuses an http API call", async () => {
    const spy = spyApi();
    const navigation = await handleRequest(new Request(`http://${ADMIN_HOST}/platform/shops?x=1`), adminEnv(spy.api));
    expect(navigation.status).toBe(301);
    expect(navigation.headers.get("location")).toBe(`${ADMIN_ORIGIN}/platform/shops?x=1`);
    const call = await handleRequest(new Request(`http://${ADMIN_HOST}/_api/v1/me`), adminEnv(spy.api));
    expect(call.status).toBe(404);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("/_api: the allowlist at the door", () => {
  const refused: [string, string][] = [
    ["GET", "/_api/v1/storefront"],
    ["GET", "/_api/v1/products"],
    ["POST", "/_api/v1/checkout"],
    ["POST", "/_api/v1/webhooks/stripe"],
    ["GET", "/_api/v1/render/jobs"],
    ["POST", "/_api/v1/staging/fake-printer/orders"],
    ["POST", "/_api/v1/platform/bootstrap"],
    ["POST", "/_api/api/auth/sign-up/email"],
    ["GET", "/_api/health"],
    ["GET", "/_api/v1/admin/a%2fb"],
    ["GET", "/_api/v1/admin/a%5Cb"],
    ["GET", "/_api/v1/admin//products"],
    ["OPTIONS", "/_api/v1/admin/products"],
    ["GET", "/_api"],
  ];

  for (const [method, path] of refused) {
    it(`${method} ${path} → opaque 404, the API never called`, async () => {
      const spy = spyApi();
      const response = await handleRequest(browser(method, path, { origin: ADMIN_ORIGIN }), adminEnv(spy.api));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
      expect(spy.calls).toHaveLength(0);
    });
  }

  it("never forwards a dot segment the URL parser resolved into a refused path", async () => {
    const spy = spyApi();
    for (const path of ["/_api/v1/admin/../storefront", "/_api/v1/admin/%2e%2e/storefront", "/_api/v1/admin/x/../../webhooks/stripe"]) {
      const response = await handleRequest(new Request(`${ADMIN_ORIGIN}${path}`), adminEnv(spy.api));
      expect(response.status).toBe(404);
    }
    expect(spy.calls).toHaveLength(0);
  });

  it("answers 502 when the binding throws", async () => {
    const spy = spyApi(() => {
      throw new Error("down");
    });
    const response = await handleRequest(browser("GET", "/_api/v1/me"), adminEnv(spy.api));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });
});

describe("/_api: the forwarded request", () => {
  it("keeps the browser's host and scheme, strips /_api, keeps the query", async () => {
    const spy = spyApi();
    await handleRequest(browser("GET", "/_api/v1/admin/products?cursor=abc&limit=5"), adminEnv(spy.api));
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toBe(`${ADMIN_ORIGIN}/v1/admin/products?cursor=abc&limit=5`);
  });

  it("forwards the cookie, the shop and the client headers, and drops what a browser could forge", async () => {
    const spy = spyApi();
    await handleRequest(
      browser("PATCH", "/_api/v1/admin/products/p-1", {
        body: '{"title":"x"}',
        cookie: "__Secure-better-auth.session_token=tok",
        headers: {
          accept: "application/json",
          authorization: "Bearer x",
          "idempotency-key": "idem-1",
          "if-none-match": '"e"',
          "x-bootstrap-token": "b".repeat(40),
          "x-forwarded-for": "198.51.100.7",
          "x-shop-id": TENANT,
          "x-storefront-preview": "v1.2.3",
          "x-tenant-id": "someone-else",
        },
      }),
      adminEnv(spy.api),
    );
    const sent = spy.calls[0];
    expect(sent?.method).toBe("PATCH");
    expect(sent?.headers.get("cookie")).toBe("__Secure-better-auth.session_token=tok");
    expect(sent?.headers.get("origin")).toBe(ADMIN_ORIGIN);
    expect(sent?.headers.get("x-shop-id")).toBe(TENANT);
    expect(sent?.headers.get("idempotency-key")).toBe("idem-1");
    expect(sent?.headers.get("if-none-match")).toBe('"e"');
    expect(sent?.headers.get("accept")).toBe("application/json");
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(sent?.headers.get("cf-connecting-ip")).toBe("203.0.113.50");
    for (const dropped of ["authorization", "x-bootstrap-token", "x-forwarded-for", "x-storefront-preview", "x-tenant-id"]) {
      expect(sent?.headers.has(dropped)).toBe(false);
    }
    expect(await sent?.text()).toBe('{"title":"x"}');
  });

  it("passes several Set-Cookie headers back unchanged, with the API's status and body", async () => {
    const spy = spyApi(() => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly; Secure; SameSite=Lax");
      headers.append("set-cookie", "b=2; Max-Age=0; Path=/");
      return new Response('{"ok":true}', { headers, status: 200 });
    });
    const response = await handleRequest(browser("POST", "/_api/api/auth/sign-out", { body: "{}" }), adminEnv(spy.api));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly; Secure; SameSite=Lax",
      "b=2; Max-Age=0; Path=/",
    ]);
    expect(await response.text()).toBe('{"ok":true}');
    // JSON: the admin headers, no policy.
    expect(response.headers.has("content-security-policy")).toBe(false);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("streams a large body through without reading it, with its declared length", async () => {
    const CHUNK = 1024 * 1024;
    const CHUNKS = 48; // 48 MiB: far past anything a buffered copy would hold comfortably
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === CHUNKS) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(new Uint8Array(CHUNK).fill(produced % 256));
      },
    });
    let received = 0;
    let declared: string | null = null;
    let producedWhenCalled = -1;
    const spy = spyApi(async (request) => {
      producedWhenCalled = produced;
      declared = request.headers.get("content-length");
      const reader = request.body?.getReader();
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        received += chunk.value.byteLength;
      }
      return Response.json({ received });
    });
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/_api/v1/admin/objects/o-1/content`, {
        body: stream,
        headers: {
          "content-length": String(CHUNK * CHUNKS),
          "content-type": "application/octet-stream",
          cookie: "s=1",
          origin: ADMIN_ORIGIN,
          "x-shop-id": TENANT,
        },
        method: "PUT",
      }),
      adminEnv(spy.api),
    );
    expect(response.status).toBe(200);
    // The API was called before the body was drained: it streams, it is not buffered first.
    expect(producedWhenCalled).toBeLessThan(CHUNKS);
    expect(received).toBe(CHUNK * CHUNKS);
    expect(declared).toBe(String(CHUNK * CHUNKS));
  });
});

describe("the application: shell and files", () => {
  for (const path of ["/", "/login", "/reset-password?token=abc", "/admin/products", "/platform", "/platform/shops/s-1", "/index.html"]) {
    it(`GET ${path} → the shell, no-store, with the enforced policy`, async () => {
      const spy = spyApi();
      const response = await handleRequest(new Request(`${ADMIN_ORIGIN}${path}`), adminEnv(spy.api));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain(`img-src 'self' data: blob: ${PUBLIC_ORIGIN} https://*.r2.cloudflarestorage.com`);
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(spy.calls).toHaveLength(0);
    });
  }

  it("serves a hashed asset immutable, a top-level file no-cache, and 404s a missing file (never the shell)", async () => {
    const env1 = adminEnv(spyApi().api);
    const asset = await handleRequest(new Request(`${ADMIN_ORIGIN}/assets/index-abc.js`), env1);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.has("content-security-policy")).toBe(false);

    const icon = await handleRequest(new Request(`${ADMIN_ORIGIN}/favicon.ico`), env1);
    expect(icon.headers.get("cache-control")).toBe("no-cache");

    for (const missing of ["/assets/gone-123.js", "/missing.json"]) {
      const response = await handleRequest(new Request(`${ADMIN_ORIGIN}${missing}`), env1);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("<div id=\"root\">");
    }
  });

  it("answers 503 when the build has no shell", async () => {
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/login`),
      adminEnv(spyApi().api, { ASSETS: { fetch: async () => new Response("no", { status: 404 }) } }),
    );
    expect(response.status).toBe(503);
  });

  it("disallows every crawler", async () => {
    const response = await handleRequest(new Request(`${ADMIN_ORIGIN}/robots.txt`), adminEnv(spyApi().api));
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses a state change outside /_api", async () => {
    const response = await handleRequest(
      new Request(`${ADMIN_ORIGIN}/login`, { body: "x", method: "POST" }),
      adminEnv(spyApi().api),
    );
    expect(response.status).toBe(404);
  });
});

describe("Better Auth behind the proxy (the real API app)", () => {
  it("refuses a sign-in from an admin origin the API does not trust (the wiring the API needs)", async () => {
    const response = await signInThroughProxy(realInternal);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INVALID_ORIGIN" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("signs in on the admin host when AUTH_BASE_URL is the API's, and sets a host-only Secure cookie", async () => {
    const response = await signInThroughProxy(apiTrusting(ADMIN_ORIGIN));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { email: EMAIL } });

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.includes("session_token="));
    expect(session).toBeDefined();
    const attributes = (session ?? "").split(";").map((part) => part.trim().toLowerCase());
    // Secure because AUTH_BASE_URL is https: the __Secure- prefix and the attribute.
    expect(session?.startsWith("__Secure-better-auth.session_token=")).toBe(true);
    expect(attributes).toContain("secure");
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("path=/");
    // No Domain attribute: the browser keeps it for the host that answered — the admin host.
    expect(attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
  });

  it("the cookie then carries the session through the proxy: get-session, an admin write, sign-out", async () => {
    const api = apiTrusting(ADMIN_ORIGIN);
    const signedIn = await signInThroughProxy(api);
    const setCookie = signedIn.headers.getSetCookie().find((cookie) => cookie.includes("session_token=")) ?? "";
    const cookie = cookiePair(setCookie);
    expect(cookie.length).toBeGreaterThan(40);

    const session = await handleRequest(browser("GET", "/_api/api/auth/get-session", { cookie }), adminEnv(api));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: EMAIL, id: userId } });

    // An admin state change: the API's own same-origin check passes because
    // the forwarded URL is on the admin host and Origin is the admin origin.
    const code = `WX${Date.now().toString(36).toUpperCase()}`;
    const created = await handleRequest(
      browser("POST", "/_api/v1/admin/discount-codes", {
        body: JSON.stringify({ code, percentBp: 1_000, scope: "all", type: "percent" }),
        cookie,
        headers: { "x-shop-id": TENANT },
      }),
      adminEnv(api),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ discountCode: { code } });

    // The proxy vouches for nothing: a foreign or missing Origin stays what it is.
    for (const origin of ["https://evil.test", AUTH_ORIGIN, null]) {
      const refused = await handleRequest(
        browser("POST", "/_api/v1/admin/discount-codes", {
          body: JSON.stringify({ code: `${code}X`, percentBp: 1_000, scope: "all", type: "percent" }),
          cookie,
          headers: { "x-shop-id": TENANT },
          origin,
        }),
        adminEnv(api),
      );
      expect(refused.status).toBe(404);
    }

    // A tenant header a browser invents reaches nothing: without X-Shop-Id the admin route is the opaque 404.
    const noShop = await handleRequest(
      browser("GET", "/_api/v1/admin/discount-codes/x", { cookie, headers: { "x-tenant-id": TENANT } }),
      adminEnv(api),
    );
    expect(noShop.status).toBe(404);

    const signedOut = await handleRequest(
      browser("POST", "/_api/api/auth/sign-out", { body: "{}", cookie }),
      adminEnv(api),
    );
    expect(signedOut.status).toBe(200);
    const cleared = signedOut.headers.getSetCookie().find((value) => value.includes("session_token="));
    expect(cleared?.toLowerCase()).toContain("max-age=0");

    const after = await handleRequest(browser("GET", "/_api/api/auth/get-session", { cookie }), adminEnv(api));
    expect(await after.json()).toBeNull();
  });
});
