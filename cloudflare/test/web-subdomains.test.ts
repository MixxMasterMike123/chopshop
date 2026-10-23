import { describe, expect, it } from "vitest";

import type { ApiBinding, AssetsBinding, WebEnv } from "../web/src/env";
import { platformShopDomain, readWebConfig } from "../web/src/env";
import { handleRequest } from "../web/src/index";
import { labelUnder, subdomainLocation, subdomainQuestion } from "../web/src/subdomain";

/**
 * CP14 — the web Worker's subdomain redirects: `/<shop>/…` on the shared host
 * 301s to `https://<label>.<base>/…` (path and query kept), a platform
 * hostname the shop moved away from 301s to its current one, and nothing
 * redirects while PLATFORM_SHOP_DOMAIN is absent. The API side of the answer
 * (`canonicalPlatformHostname`) is test/shop-subdomains.test.ts.
 */

const WEB_ORIGIN = "https://web.test.invalid";
const BASE = "shops.test.invalid";
const SHELL = "<!doctype html><html><head><title>Shop</title></head><body><div id=\"root\"></div></body></html>";

function assets(): AssetsBinding {
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/index.html") {
        return new Response(SHELL, { headers: { "content-type": "text/html" } });
      }
      if (path === "/assets/app.js") {
        return new Response("1", { headers: { "content-type": "text/javascript" } });
      }
      return new Response("missing", { status: 404 });
    },
  };
}

type Target = { hostname: string } | { shop: string };

/** An API whose canonicalShopHost answers `answer(target)`, recording every question. */
function api(answer: (target: Target) => unknown): { api: ApiBinding; asked: Target[]; calls: string[] } {
  const asked: Target[] = [];
  const calls: string[] = [];
  const seo = (request: Request) => {
    calls.push(new URL(request.url).pathname);
    return Promise.resolve(Response.json({ page: { title: "T" } }));
  };
  return {
    api: {
      canonicalShopHost: async (target) => {
        asked.push(target);
        return answer(target) as string | null;
      },
      fetch: seo,
      fetchForShop: (_shop, request) => seo(request),
    },
    asked,
    calls,
  };
}

/** `base` null = the var absent. */
function webEnv(binding: ApiBinding, base: string | null = BASE): WebEnv {
  return {
    API: binding,
    ASSETS: assets(),
    PLATFORM_SHOP_DOMAIN: base ?? undefined,
    PUBLIC_OBJECT_BASE_URL: undefined,
    WEB_ORIGIN,
  };
}

const page = (url: string, method = "GET") => new Request(url, { headers: { accept: "text/html" }, method });

describe("the pure parts", () => {
  it("reads PLATFORM_SHOP_DOMAIN as a lowercase hostname, anything else as off", () => {
    expect(platformShopDomain(BASE)).toBe(BASE);
    expect(platformShopDomain("flippinstuff.se")).toBe("flippinstuff.se");
    for (const off of [undefined, "", "se", "Shops.test", "https://shops.test", ".shops.test", "shops.test.", "*.shops.test"]) {
      expect(platformShopDomain(off), String(off)).toBeNull();
    }
    expect(readWebConfig(webEnv(api(() => null).api))?.platformShopDomain).toBe(BASE);
    expect(readWebConfig(webEnv(api(() => null).api, null))?.platformShopDomain).toBeNull();
  });

  it("finds the label of a host exactly one label under the base", () => {
    expect(labelUnder(`melodiemc.${BASE}`, BASE)).toBe("melodiemc");
    expect(labelUnder(`a.b.${BASE}`, BASE)).toBeNull();
    expect(labelUnder(BASE, BASE)).toBeNull();
    expect(labelUnder(`melodiemc.evil${BASE}`, BASE)).toBeNull();
    expect(labelUnder("melodiemc.elsewhere.test", BASE)).toBeNull();
  });

  it("asks about the shared host's shop and about hosts under the base, nothing else", () => {
    const shared = { root: "/melodie-mc", shop: "melodie-mc" };
    const own = { root: "", shop: null };
    expect(subdomainQuestion(BASE, new URL(`${WEB_ORIGIN}/melodie-mc/produkt/x`), shared)).toEqual({
      path: "/produkt/x",
      target: { shop: "melodie-mc" },
    });
    expect(subdomainQuestion(BASE, new URL(`${WEB_ORIGIN}/melodie-mc`), shared)).toEqual({
      path: "/",
      target: { shop: "melodie-mc" },
    });
    expect(subdomainQuestion(BASE, new URL(`https://gamla.${BASE}/kassa`), own)).toEqual({
      path: "/kassa",
      target: { hostname: `gamla.${BASE}` },
    });
    expect(subdomainQuestion(BASE, new URL("https://melodiemc.com/kassa"), own)).toBeNull();
    expect(subdomainQuestion(BASE, new URL(`https://gamla.${BASE}:8443/`), own)).toBeNull();
    expect(subdomainQuestion(null, new URL(`${WEB_ORIGIN}/melodie-mc/`), shared)).toBeNull();
  });

  it("follows only an answer one label under the base that is not this host", () => {
    const url = new URL(`${WEB_ORIGIN}/melodie-mc/x?a=1&b=%20`);
    expect(subdomainLocation(BASE, `melodiemc.${BASE}`, url, "/x")).toBe(`https://melodiemc.${BASE}/x?a=1&b=%20`);
    for (const answer of [null, undefined, 7, "", "evil.test", `a.b.${BASE}`, `melodiemc.${BASE}/x`, "timeout"]) {
      expect(subdomainLocation(BASE, answer, url, "/x"), String(answer)).toBeNull();
    }
    const self = new URL(`https://melodiemc.${BASE}/x`);
    expect(subdomainLocation(BASE, `melodiemc.${BASE}`, self, "/x")).toBeNull();
  });
});

describe("handleRequest", () => {
  it("301s /<shop>/… on the shared host to the shop's subdomain, path and query kept", async () => {
    const spy = api(() => `melodiemc.${BASE}`);
    const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/produkt/t-shirt?farg=svart`), webEnv(spy.api));
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://melodiemc.${BASE}/produkt/t-shirt?farg=svart`);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(spy.asked).toEqual([{ shop: "melodie-mc" }]);
    // Redirected before the SEO call: the API is asked nothing else.
    expect(spy.calls).toEqual([]);

    const root = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc`), webEnv(spy.api));
    expect(root.headers.get("Location")).toBe(`https://melodiemc.${BASE}/`);
    const head = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`, "HEAD"), webEnv(spy.api));
    expect(head.status).toBe(301);
  });

  it("301s the shared host's sitemap too", async () => {
    const spy = api(() => `melodiemc.${BASE}`);
    const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/sitemap.xml`), webEnv(spy.api));
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://melodiemc.${BASE}/sitemap.xml`);
  });

  it("serves the page as before when the shop has no label (the API answers null)", async () => {
    const spy = api(() => null);
    const response = await handleRequest(page(`${WEB_ORIGIN}/sillmans/`), webEnv(spy.api));
    expect(response.status).toBe(200);
    expect(spy.asked).toEqual([{ shop: "sillmans" }]);
    expect(spy.calls).toEqual(["/v1/seo"]);
  });

  it("never follows an answer outside the base, and a failing or slow API is no redirect", async () => {
    for (const answer of ["evil.example", `x.y.${BASE}`, 42]) {
      const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`), webEnv(api(() => answer).api));
      expect(response.status, String(answer)).toBe(200);
    }
    const failing: ApiBinding = {
      ...api(() => null).api,
      canonicalShopHost: () => Promise.reject(new Error("down")),
    };
    expect((await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`), webEnv(failing))).status).toBe(200);
    const slow: ApiBinding = {
      ...api(() => null).api,
      canonicalShopHost: () => new Promise(() => undefined),
    };
    const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`), webEnv(slow), { seoDeadlineMs: 20 });
    expect(response.status).toBe(200);
  });

  it("301s a platform hostname the shop moved away from to its current one", async () => {
    const spy = api((target) => ("hostname" in target && target.hostname === `gamla.${BASE}` ? `nya.${BASE}` : null));
    const response = await handleRequest(page(`https://gamla.${BASE}/kassa?steg=2`), webEnv(spy.api));
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://nya.${BASE}/kassa?steg=2`);
    expect(spy.asked).toEqual([{ hostname: `gamla.${BASE}` }]);

    // The canonical host itself: asked, answered null, served.
    const current = await handleRequest(page(`https://nya.${BASE}/kassa`), webEnv(spy.api));
    expect(current.status).toBe(200);
  });

  it("never asks about a shop's own domain, the API path, a static file, or a write", async () => {
    const spy = api(() => `melodiemc.${BASE}`);
    expect((await handleRequest(page("https://melodiemc.com/"), webEnv(spy.api))).status).toBe(200);
    const apiCall = await handleRequest(page(`${WEB_ORIGIN}/_api/melodie-mc/v1/storefront`), webEnv(spy.api));
    expect(apiCall.status).not.toBe(301);
    const file = await handleRequest(page(`https://gamla.${BASE}/assets/app.js`), webEnv(spy.api));
    expect(file.status).toBe(200);
    const post = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`, "POST"), webEnv(spy.api));
    expect(post.status).toBe(404);
    expect(spy.asked).toEqual([]);
  });

  it("feature off: asks nothing and serves /<shop>/ exactly as before", async () => {
    const spy = api(() => `melodiemc.${BASE}`);
    for (const base of [null, "", "Not A Domain"]) {
      const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/produkt/x`), webEnv(spy.api, base));
      expect(response.status, String(base)).toBe(200);
      const hosted = await handleRequest(page(`https://gamla.${BASE}/`), webEnv(spy.api, base));
      expect(hosted.status, String(base)).toBe(200);
    }
    expect(spy.asked).toEqual([]);
  });

  it("an API binding without the method (an older API) redirects nothing", async () => {
    const { canonicalShopHost: _unused, ...older } = api(() => `melodiemc.${BASE}`).api;
    const response = await handleRequest(page(`${WEB_ORIGIN}/melodie-mc/`), webEnv(older));
    expect(response.status).toBe(200);
  });
});
