import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { ApiBinding, AssetsBinding, WebEnv } from "../web/src/env";
import { escapeHtml } from "../web/src/html";
import { handleRequest } from "../web/src/index";

/**
 * CP4-E — the web Worker end to end: `handleRequest` with a fake asset store,
 * and either a spy standing in for the API (to see exactly what the Worker
 * sends and to play the SEO answers the API does not have yet) or the REAL
 * `Internal` entrypoint of this API over its test export (to prove the
 * forwarding reaches the right shop).
 */

const WEB_ORIGIN = "https://web.test.invalid";
const PUBLIC_ORIGIN = "https://pub.test.invalid";
const SHOP_A = "web-shop-a";
const SHOP_B = "web-shop-b";
const HOST_A = "web-shop-a.shop.test";
const NOW = 1_787_700_000_000;

const SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<title>My Shop</title>
<meta name="description" content="Quality products, delivered." />
<meta property="og:title" content="My Shop" />
</head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;

const HOSTILE = `</title><script>alert("x")</script>`;

interface ApiCall {
  request: Request;
  shop: string | null;
}

const ASSET_FILES: Record<string, { body: string; type: string }> = {
  "/assets/index-abc.js": { body: "console.log(1)", type: "text/javascript" },
  "/favicon.ico": { body: "ico", type: "image/x-icon" },
  "/index.html": { body: SHELL, type: "text/html" },
};

function assets(): AssetsBinding {
  return {
    fetch: async (request) => {
      const file = ASSET_FILES[new URL(request.url).pathname];
      return file === undefined
        ? new Response("missing", { status: 404 })
        : new Response(file.body, { headers: { "content-type": file.type, etag: '"a1"' } });
    },
  };
}

type Answer = (request: Request, shop: string | null) => Promise<Response> | Response;

function spyApi(answer: Answer): { api: ApiBinding; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  return {
    api: {
      fetch: async (request) => {
        calls.push({ request, shop: null });
        return answer(request, null);
      },
      fetchForShop: async (shop, request) => {
        calls.push({ request, shop });
        return answer(request, shop);
      },
    },
    calls,
  };
}

const realApi: ApiBinding = {
  fetch: (request) => exports.Internal.fetch(request),
  fetchForShop: (shop, request) => exports.Internal.fetchForShop(shop, request),
};

function webEnv(api: ApiBinding, vars: Partial<WebEnv> = {}): WebEnv {
  return {
    API: api,
    ASSETS: assets(),
    PUBLIC_OBJECT_BASE_URL: PUBLIC_ORIGIN,
    WEB_ORIGIN,
    ...vars,
  };
}

function navigation(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { accept: "text/html,application/xhtml+xml", ...(init.headers ?? {}) },
  });
}

function seoPage(page: Record<string, unknown>): Response {
  return Response.json({ page: { title: "T", ...page } });
}

async function seed(tenantId: string, hostname: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants (
       tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at
     ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
  )
    .bind(tenantId, `Shop ${tenantId}`, NOW, NOW)
    .run();
  if (hostname !== null) {
    await env.DB.prepare(
      `INSERT INTO tenant_domains (
         domain_id, tenant_id, hostname, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    )
      .bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW)
      .run();
  }
}

beforeAll(async () => {
  await seed(SHOP_A, HOST_A);
  await seed(SHOP_B, "web-shop-b.shop.test");
});

async function storefrontName(response: Response): Promise<string> {
  return (await response.json<{ storefront: { name: string } }>()).storefront.name;
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  expect(response.headers.get("content-security-policy-report-only")).toContain(
    `img-src 'self' data: blob: ${PUBLIC_ORIGIN}`,
  );
}

describe("/_api on the shared host (real API)", () => {
  it("reaches the shop named in the path", async () => {
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/storefront`),
      webEnv(realApi),
    );

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    // "<catalog_version>-r<revision>" (CP8-DC, public-routes.ts STOREFRONT_BODY_REVISION),
    // "-x" while the shop cannot take an order (CP9-OB).
    expect(response.headers.get("etag")).toMatch(/^"\d+-r\d+(-x)?"$/);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${SHOP_A}`);
  });

  it("serves the path's shop whatever tenant header the browser sends", async () => {
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/storefront`, {
        headers: { "X-Tenant-Host": "web-shop-b.shop.test", "X-Tenant-Id": SHOP_B },
      }),
      webEnv(realApi),
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${SHOP_A}`);
  });

  it("lets the browser revalidate by ETag", async () => {
    const first = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_B}/v1/storefront`),
      webEnv(realApi),
    );
    const etag = first.headers.get("etag") ?? "";
    const second = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_B}/v1/storefront`, { headers: { "if-none-match": etag } }),
      webEnv(realApi),
    );

    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("answers the API's opaque 404 for a shop with no storefront hostname", async () => {
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/no-such-shop/v1/storefront`),
      webEnv(realApi),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });
});

describe("/_api on a shop's own domain (real API)", () => {
  it("reaches the shop of the hostname, with no prefix", async () => {
    const response = await handleRequest(
      new Request(`https://${HOST_A}/_api/v1/storefront`),
      webEnv(realApi),
    );

    expect(response.status).toBe(200);
    await expect(storefrontName(response)).resolves.toBe(`Shop ${SHOP_A}`);
  });

  it("refuses a shop prefix there", async () => {
    const { api, calls } = spyApi(() => new Response("{}"));
    const response = await handleRequest(
      new Request(`https://${HOST_A}/_api/${SHOP_B}/v1/storefront`),
      webEnv(api),
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("/_api refusals: nothing reaches the API", () => {
  it.each([
    ["GET", `/_api/${SHOP_A}/v1/admin/products`],
    ["POST", `/_api/${SHOP_A}/v1/admin/products`],
    ["GET", `/_api/${SHOP_A}/v1/admin/settings`],
    ["GET", `/_api/${SHOP_A}/v1/platform/tenants`],
    ["POST", `/_api/${SHOP_A}/v1/platform/bootstrap`],
    ["GET", `/_api/${SHOP_A}/v1/render/jobs/acquire`],
    ["POST", `/_api/${SHOP_A}/v1/webhooks/stripe`],
    ["GET", `/_api/${SHOP_A}/v1/staging/fake-printer/jobs`],
    ["POST", `/_api/${SHOP_A}/api/auth/sign-in/email`],
    ["GET", `/_api/${SHOP_A}/api/auth/get-session`],
    ["GET", `/_api/${SHOP_A}/v1/%61dmin/products`],
    ["GET", `/_api/${SHOP_A}/v1/products/%2e%2e/admin/products`],
    ["GET", `/_api/${SHOP_A}/v1/products/..%2F..%2Fadmin`],
    ["GET", `/_api/${SHOP_A}/v1/seo?path=%2F`],
    ["GET", `/_api/${SHOP_A}/v1/sitemap`],
    ["GET", `/_api/${SHOP_A}/health`],
    ["GET", "/_api/admin/v1/storefront"],
    ["GET", "/_api/Web-Shop-A/v1/storefront"],
    ["GET", "/_api/v1/storefront"],
    ["DELETE", `/_api/${SHOP_A}/v1/products/x`],
  ])("%s %s", async (method, path) => {
    const { api, calls } = spyApi(() => new Response("{}"));
    const response = await handleRequest(new Request(`${WEB_ORIGIN}${path}`, { method }), webEnv(api));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("what the API receives", () => {
  it("the path and query as the browser sent them, minus the prefix, on the web origin", async () => {
    const { api, calls } = spyApi(() => Response.json({ products: [] }));
    await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/products?tag=sommar&cursor=a%2Fb`),
      webEnv(api),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.shop).toBe(SHOP_A);
    expect(calls[0]?.request.url).toBe(`${WEB_ORIGIN}/v1/products?tag=sommar&cursor=a%2Fb`);
  });

  it("no X-Tenant-* header, the visitor's address, and the receipt bearer", async () => {
    const { api, calls } = spyApi(() => Response.json({}));
    await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/orders/4f6e2a9c-1b3d-4e5f-8a7b-9c0d1e2f3a4b`, {
        headers: {
          authorization: "Bearer receipt-token",
          "cf-connecting-ip": "198.51.100.23",
          "X-Tenant-Host": "web-shop-b.shop.test",
          "x-tenant-id": SHOP_B,
        },
      }),
      webEnv(api),
    );

    const forwarded = calls[0]?.request;
    expect(forwarded).toBeDefined();
    expect([...(forwarded?.headers.keys() ?? [])].filter((name) => /^x-tenant-/i.test(name))).toEqual([]);
    expect(forwarded?.headers.get("cf-connecting-ip")).toBe("198.51.100.23");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer receipt-token");
  });

  it("a POST body as it came, and a bodyless POST with no body", async () => {
    const { api, calls } = spyApi(() => Response.json({}, { status: 201 }));
    await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/checkout`, {
        body: '{"items":[]}',
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      webEnv(api),
    );
    await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/checkout/c1/payment`, {
        headers: { "content-length": "0" },
        method: "POST",
      }),
      webEnv(api),
    );

    await expect(calls[0]?.request.text()).resolves.toBe('{"items":[]}');
    expect(calls[1]?.request.body).toBeNull();
  });

  it("gives the browser the API's answer without a cookie", async () => {
    const { api } = spyApi(() =>
      Response.json({ ok: true }, { headers: { "set-cookie": "a=b", "retry-after": "7" }, status: 429 }),
    );
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/storefront`),
      webEnv(api),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("answers 502 when the binding itself fails", async () => {
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/storefront`),
      webEnv({
        fetch: () => Promise.reject(new Error("down")),
        fetchForShop: () => Promise.reject(new Error("down")),
      }),
    );

    expect(response.status).toBe(502);
  });
});

describe("a navigation", () => {
  it("gets the page's head, escaped, and its body text in the root element", async () => {
    const { api, calls } = spyApi((request) =>
      new URL(request.url).pathname === "/v1/seo"
        ? seoPage({
            bodyHtml: `<h1>${escapeHtml(HOSTILE)}</h1><script>alert(1)</script><a href="/cart">Kassa</a>`,
            canonicalPath: "/product/t-shirt",
            description: "En tröja",
            image: { height: 600, url: `${PUBLIC_ORIGIN}/shops/a/product_media/o/v1/t.jpg`, width: 800 },
            jsonLd: { "@type": "Product", name: HOSTILE, url: { "@relative": "/product/t-shirt" } },
            robots: null,
            title: HOSTILE,
          })
        : new Response("{}", { status: 404 }),
    );

    const response = await handleRequest(
      navigation(`${WEB_ORIGIN}/${SHOP_A}/product/t-shirt?utm=x`, {
        headers: { cookie: "c=1", "cf-connecting-ip": "203.0.113.5" },
      }),
      webEnv(api),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expectSecurityHeaders(response);

    // One SEO call, for the path under the root, carrying the visitor's
    // address and nothing else of the browser's.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.shop).toBe(SHOP_A);
    expect(calls[0]?.request.url).toBe(`${WEB_ORIGIN}/v1/seo?path=%2Fproduct%2Ft-shirt`);
    expect(calls[0]?.request.headers.get("cf-connecting-ip")).toBe("203.0.113.5");
    expect(calls[0]?.request.headers.get("cookie")).toBeNull();

    // The product named </title><script> stays text everywhere.
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(`<title>${escapeHtml(HOSTILE)}</title>`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).not.toContain("My Shop");
    expect(html).toContain(
      `<link rel="canonical" href="${WEB_ORIGIN}/${SHOP_A}/product/t-shirt">`,
    );
    expect(html).toContain(
      `<meta property="og:image" content="${PUBLIC_ORIGIN}/shops/a/product_media/o/v1/t.jpg">`,
    );
    expect(html).toContain(`"url":"${WEB_ORIGIN}/${SHOP_A}/product/t-shirt"`);
    expect(html).toContain('"name":"\\u003c/title\\u003e\\u003cscript\\u003e');
    expect(html).toContain(`<meta name="storefront-root" content="/${SHOP_A}">`);
    expect(html).toContain(
      `<div id="root"><h1>${escapeHtml(HOSTILE)}</h1><a href="/${SHOP_A}/cart">Kassa</a></div>`,
    );
  });

  it("writes no Open Graph image that is not on the public object origin", async () => {
    const { api } = spyApi(() => seoPage({ image: { url: "https://evil.test/x.jpg" } }));
    const html = await (await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/`), webEnv(api))).text();

    expect(html).not.toContain("og:image");
    expect(html).not.toContain("evil.test");
  });

  it.each([
    ["the API has no head for it (404)", () => new Response("{}", { status: 404 })],
    ["the API fails (500)", () => new Response("boom", { status: 500 })],
    ["the binding throws", () => Promise.reject(new Error("down"))],
    ["the answer is not JSON", () => new Response("<html>", { status: 200 })],
    ["the answer has another shape", () => Response.json({ page: { title: 5 } })],
  ])("still serves the application when %s", async (_label, answer) => {
    const { api } = spyApi(answer);
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/cart`), webEnv(api));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>My Shop</title>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(`<meta name="storefront-root" content="/${SHOP_A}">`);
  });

  it("does not wait for a slow API past the deadline", async () => {
    const { api } = spyApi(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/`), webEnv(api), {
      seoDeadlineMs: 30,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>My Shop</title>");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("serves the application through the real API, with the head the API gives the page", async () => {
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/produkter`), webEnv(realApi));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>Alla produkter | ");
    expect(html).not.toContain("<title>My Shop</title>");
    expect(html).toContain(`<link rel="canonical" href="${WEB_ORIGIN}/${SHOP_A}/produkter">`);
    expect(html).toContain(`<meta name="storefront-root" content="/${SHOP_A}">`);
  });

  it("on a shop's own domain writes an empty root and asks the hostname's shop", async () => {
    const { api, calls } = spyApi(() => seoPage({ canonicalPath: "/" }));
    const html = await (await handleRequest(navigation(`https://${HOST_A}/`), webEnv(api))).text();

    expect(calls[0]?.shop).toBeNull();
    expect(calls[0]?.request.url).toBe(`https://${HOST_A}/v1/seo?path=%2F`);
    expect(html).toContain('<meta name="storefront-root" content="">');
    expect(html).toContain(`<link rel="canonical" href="https://${HOST_A}/">`);
  });

  it("serves the application as a 404, with no root, on the shared host without a shop", async () => {
    for (const path of ["/", "/admin", "/login", "/Web-Shop-A/cart"]) {
      const { api, calls } = spyApi(() => seoPage({}));
      const response = await handleRequest(navigation(`${WEB_ORIGIN}${path}`), webEnv(api));
      const html = await response.text();

      expect(response.status, path).toBe(404);
      expect(html, path).toContain("<title>My Shop</title>");
      expect(html, path).not.toContain("storefront-root");
      expect(calls, path).toHaveLength(0);
    }
  });

  it("answers 404 to a method that is not a read", async () => {
    const { api, calls } = spyApi(() => seoPage({}));
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/${SHOP_A}/cart`, { method: "POST" }),
      webEnv(api),
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("a forward (D88)", () => {
  it("is a 301 to a path under the shop's root", async () => {
    const { api } = spyApi(() => Response.json({ redirect: { status: 301, to: "/product/ny-troja" } }));
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/products/old`), webEnv(api));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/${SHOP_A}/product/ny-troja`);
    expectSecurityHeaders(response);
  });

  it("is a 301 to a root path on a shop's own domain", async () => {
    const { api } = spyApi(() => Response.json({ redirect: { status: 301, to: "/product/ny-troja" } }));
    const response = await handleRequest(navigation(`https://${HOST_A}/products/old`), webEnv(api));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/product/ny-troja");
  });

  it.each([
    "https://evil.test/x",
    "//evil.test/x",
    "/\\evil.test",
    "/../web-shop-b/x",
    "/%2e%2e/web-shop-b/x",
    "javascript:alert(1)",
    "/a\r\nSet-Cookie: x=y",
  ])("is never followed out of the shop's root: %j", async (to) => {
    const { api } = spyApi(() => Response.json({ redirect: { status: 301, to } }));
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP_A}/old`), webEnv(api));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("<title>My Shop</title>");
  });
});

describe("files of the build", () => {
  it("serves a hashed file as immutable", async () => {
    const { api } = spyApi(() => new Response("{}"));
    const response = await handleRequest(new Request(`${WEB_ORIGIN}/assets/index-abc.js`), webEnv(api));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(response);
    await expect(response.text()).resolves.toBe("console.log(1)");
  });

  it("serves any other file with no-cache", async () => {
    const { api } = spyApi(() => new Response("{}"));
    const response = await handleRequest(new Request(`${WEB_ORIGIN}/favicon.ico`), webEnv(api));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 404 for a file the build does not have", async () => {
    const { api, calls } = spyApi(() => new Response("{}"));
    const response = await handleRequest(new Request(`${WEB_ORIGIN}/assets/nope.js`), webEnv(api));

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("never serves the build's HTML template as a file", async () => {
    const { api } = spyApi(() => new Response("{}"));
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/index.html`), webEnv(api));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("storefront-root");
  });
});

describe("sitemap and robots", () => {
  it("writes the shop's sitemap from every page of the API's answer", async () => {
    const { api, calls } = spyApi((request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      return Response.json(
        cursor === null
          ? { entries: [{ lastModified: "2026-09-01", path: "/" }], nextCursor: "c2" }
          : { entries: [{ lastModified: null, path: "/product/a&b" }, { path: "//evil.test" }], nextCursor: null },
      );
    });
    const response = await handleRequest(new Request(`${WEB_ORIGIN}/${SHOP_A}/sitemap.xml`), webEnv(api));
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(calls.map((call) => call.request.url)).toEqual([
      `${WEB_ORIGIN}/v1/sitemap`,
      `${WEB_ORIGIN}/v1/sitemap?cursor=c2`,
    ]);
    expect(xml).toContain(`<loc>${WEB_ORIGIN}/${SHOP_A}/</loc><lastmod>2026-09-01</lastmod>`);
    expect(xml).toContain(`<loc>${WEB_ORIGIN}/${SHOP_A}/product/a&amp;b</loc>`);
    expect(xml).not.toContain("evil.test");
  });

  it("answers 404 when the API has no such shop, and 503 when it fails", async () => {
    const missing = spyApi(() => new Response("{}", { status: 404 }));
    expect(
      (await handleRequest(new Request(`${WEB_ORIGIN}/${SHOP_A}/sitemap.xml`), webEnv(missing.api))).status,
    ).toBe(404);

    const failing = spyApi(() => Promise.reject(new Error("down")));
    expect(
      (await handleRequest(new Request(`${WEB_ORIGIN}/${SHOP_A}/sitemap.xml`), webEnv(failing.api))).status,
    ).toBe(503);
  });

  it("names the sitemap in robots.txt on a shop's own domain only", async () => {
    const { api } = spyApi(() => new Response("{}"));
    const own = await (await handleRequest(new Request(`https://${HOST_A}/robots.txt`), webEnv(api))).text();
    const shared = await (await handleRequest(new Request(`${WEB_ORIGIN}/robots.txt`), webEnv(api))).text();

    expect(own).toContain(`Sitemap: https://${HOST_A}/sitemap.xml`);
    expect(own).toContain("Disallow: /_api/");
    expect(shared).not.toContain("Sitemap:");
  });
});

describe("configuration", () => {
  it("answers 503 to everything without a valid web origin", async () => {
    const { api, calls } = spyApi(() => new Response("{}"));
    for (const origin of [undefined, "", "https://web.test.invalid/", "http://web.test.invalid"]) {
      const response = await handleRequest(
        new Request(`${WEB_ORIGIN}/_api/${SHOP_A}/v1/storefront`),
        webEnv(api, { WEB_ORIGIN: origin }),
      );
      expect(response.status, String(origin)).toBe(503);
    }
    expect(calls).toHaveLength(0);
  });
});
