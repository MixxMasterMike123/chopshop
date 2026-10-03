import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { mintPreviewGrant } from "../src/storefront/preview";
import type { ApiBinding, AssetsBinding, WebEnv } from "../web/src/env";
import { PREVIEW_HEADER } from "../web/src/forward";
import { handleRequest } from "../web/src/index";

/**
 * CP4-D2 — the web Worker and the preview of an unpublished shop (D57): the
 * grant header goes on with a read and never with a write; a preview read is
 * never answered from or kept in the browser's cache; the shell of an address
 * the API has no public page for (every address of an unpublished shop) is
 * `noindex`. A spy stands in for the API where the Worker's own behaviour is
 * the point; the REAL `Internal` entrypoint proves the whole way through.
 */

const WEB_ORIGIN = "https://web.test.invalid";
const SHOP = "web-preview-a";
const HOST = "web-preview-a.shop.test";
const NOW = 1_787_700_000_000;

const SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>My Shop</title></head><body><div id="root"></div></body></html>`;

function assets(): AssetsBinding {
  return {
    fetch: async (request) =>
      new URL(request.url).pathname === "/index.html"
        ? new Response(SHELL, { headers: { "content-type": "text/html" } })
        : new Response("missing", { status: 404 }),
  };
}

function spyApi(answer: (request: Request) => Response | Promise<Response>): { api: ApiBinding; seen: Request[] } {
  const seen: Request[] = [];
  return {
    api: {
      fetch: async (request) => {
        seen.push(request);
        return answer(request);
      },
      fetchForShop: async (_shop, request) => {
        seen.push(request);
        return answer(request);
      },
    },
    seen,
  };
}

const realApi: ApiBinding = {
  fetch: (request) => exports.Internal.fetch(request),
  fetchForShop: (shop, request) => exports.Internal.fetchForShop(shop, request),
};

function webEnv(api: ApiBinding): WebEnv {
  return { API: api, ASSETS: assets(), PUBLIC_OBJECT_BASE_URL: undefined, WEB_ORIGIN };
}

const versioned = () =>
  Response.json({ storefront: { name: "x" } }, { headers: { "Cache-Control": "no-cache", ETag: '"7"' } });

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
         tenant_id, status, shop_name, default_locale, default_currency, created_at, updated_at, published
       ) VALUES (?, 'active', 'Förhandsbutik', 'sv-SE', 'SEK', ?, ?, 0)`,
    ).bind(SHOP, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
         domain_id, tenant_id, hostname, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${SHOP}`, SHOP, HOST, NOW, NOW),
  ]);
});

describe("the grant through /_api", () => {
  it("goes on with a read, without the browser's cache validators", async () => {
    const { api, seen } = spyApi(versioned);
    await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP}/v1/storefront`, {
        headers: { [PREVIEW_HEADER]: "v1.grant", "if-modified-since": "x", "if-none-match": '"7"' },
      }),
      webEnv(api),
    );
    expect(seen[0]?.headers.get(PREVIEW_HEADER)).toBe("v1.grant");
    expect(seen[0]?.headers.get("if-none-match")).toBeNull();
    expect(seen[0]?.headers.get("if-modified-since")).toBeNull();
  });

  it("never goes on with a write", async () => {
    const { api, seen } = spyApi(() => Response.json({}, { status: 201 }));
    for (const path of ["/v1/checkout", "/v1/reports", "/v1/checkout/c-1/payment", "/v1/checkout/c-1/receipt"]) {
      await handleRequest(
        new Request(`${WEB_ORIGIN}/_api/${SHOP}${path}`, {
          body: path.endsWith("payment") || path.endsWith("receipt") ? null : "{}",
          headers: { [PREVIEW_HEADER]: "v1.grant", "content-type": "application/json" },
          method: "POST",
        }),
        webEnv(api),
      );
    }
    expect(seen).toHaveLength(4);
    for (const request of seen) {
      expect(request.method).toBe("POST");
      expect(request.headers.get(PREVIEW_HEADER), new URL(request.url).pathname).toBeNull();
    }
  });

  it("a preview read's answer is never kept: no-store, no ETag, noindex — whatever the API said", async () => {
    const { api } = spyApi(versioned);
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP}/v1/storefront`, { headers: { [PREVIEW_HEADER]: "v1.expired" } }),
      webEnv(api),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("a read without the grant is forwarded and answered as before", async () => {
    const { api, seen } = spyApi(versioned);
    const response = await handleRequest(
      new Request(`${WEB_ORIGIN}/_api/${SHOP}/v1/storefront`, { headers: { "if-none-match": '"7"' } }),
      webEnv(api),
    );
    expect(seen[0]?.headers.get("if-none-match")).toBe('"7"');
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toBe('"7"');
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("through the real API: an unpublished shop is a 404 without a grant and its storefront with one", async () => {
    const url = `${WEB_ORIGIN}/_api/${SHOP}/v1/storefront`;
    const bare = await handleRequest(new Request(url), webEnv(realApi));
    expect(bare.status).toBe(404);
    await bare.body?.cancel();

    const grant = (await mintPreviewGrant(env, SHOP, Date.now()))?.grant ?? "";
    const previewed = await handleRequest(new Request(url, { headers: { [PREVIEW_HEADER]: grant } }), webEnv(realApi));
    expect(previewed.status).toBe(200);
    expect((await previewed.json<{ storefront: { name: string } }>()).storefront.name).toBe("Förhandsbutik");
    expect(previewed.headers.get("cache-control")).toBe("no-store");
    expect(previewed.headers.get("etag")).toBeNull();
    expect(previewed.headers.get("x-robots-tag")).toBe("noindex");

    const foreign = (await mintPreviewGrant(env, "web-preview-other", Date.now()))?.grant ?? "";
    const ignored = await handleRequest(new Request(url, { headers: { [PREVIEW_HEADER]: foreign } }), webEnv(realApi));
    expect(ignored.status).toBe(404);
    await ignored.body?.cancel();
  });
});

describe("the shell", () => {
  const page = (url: string) => new Request(url, { headers: { accept: "text/html" } });

  it("of an address with no public page (every address of an unpublished shop) is noindex", async () => {
    const response = await handleRequest(page(`${WEB_ORIGIN}/${SHOP}/`), webEnv(realApi));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain('<div id="root">');
  });

  it("keeps its default when the head call fails or a page answers", async () => {
    for (const answer of [
      () => new Response("boom", { status: 500 }),
      () => {
        throw new Error("down");
      },
      () => Response.json({ page: { title: "T" } }),
    ]) {
      const { api } = spyApi(answer);
      const response = await handleRequest(page(`${WEB_ORIGIN}/${SHOP}/produkter`), webEnv(api));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-robots-tag")).toBeNull();
      await response.body?.cancel();
    }
  });
});
