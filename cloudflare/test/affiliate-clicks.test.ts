import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { AFFILIATE_REF_LIMIT, parseRefParam } from "../src/affiliate/clicks";
import worker from "../src/index";
import type { ApiBinding, AssetsBinding, WebEnv } from "../web/src/env";
import { handleRequest } from "../web/src/index";
import { landingRef } from "../web/src/seo";
import { count, seedAffiliate, seedPublicShop, setFeature } from "./affiliate-fixtures";

/**
 * CP13 — link landings (design §2.1, D27, CX-B9): the web Worker carries a
 * GET page landing's `?ref=` on its SEO call, exactly once, never for a HEAD
 * or an asset, and keeps it on a forward's Location; the API counts an ACTIVE
 * affiliate of the shop while the add-on is ON — a day row, no visitor data —
 * and answers exactly what it answers without `ref`.
 */

const SHOP = "aff-clicks";
const HOST = "aff-clicks.shop.test";
const OFF = "aff-clicks-off";
const OFF_HOST = "aff-clicks-off.shop.test";
const WEB_ORIGIN = "https://web.test.invalid";

let activeId = "";
let suspendedId = "";
let offId = "";

function seo(query: string, host = HOST, ip = "203.0.113.9"): Promise<Response> {
  return worker.fetch(
    new Request(`https://${host}/v1/seo${query}`, { headers: { "cf-connecting-ip": ip } }),
    env,
  );
}

async function clicksOf(affiliateId: string): Promise<number> {
  return count("SELECT COALESCE(SUM(count), 0) AS n FROM affiliate_click_days WHERE affiliate_id = ?", affiliateId);
}

beforeAll(async () => {
  await seedPublicShop(SHOP, HOST);
  await seedPublicShop(OFF, OFF_HOST, false);
  activeId = (await seedAffiliate({ code: "CLICK1", tenantId: SHOP })).affiliateId;
  suspendedId = (await seedAffiliate({ code: "CLICKSUS", status: "suspended", tenantId: SHOP })).affiliateId;
  offId = (await seedAffiliate({ code: "CLICKOFF", tenantId: OFF })).affiliateId;
});

describe("the API's count (GET /v1/seo?path=…&ref=)", () => {
  it("counts an active affiliate's landing as one day row; the answer is the answer without ref", async () => {
    const plain = await seo("?path=%2F");
    const withRef = await seo("?path=%2F&ref=click1");
    expect(withRef.status).toBe(plain.status);
    expect(await withRef.text()).toBe(await plain.text());
    expect(await clicksOf(activeId)).toBe(1);
    const row = await env.DB.prepare("SELECT * FROM affiliate_click_days WHERE affiliate_id = ?").bind(activeId).first();
    // A day and a count: no IP, no agent, no referrer, no visitor id.
    expect(Object.keys(row ?? {}).sort()).toEqual(["affiliate_id", "count", "day", "tenant_id"]);
    expect(row?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("counts nothing for a suspended, unknown, malformed or foreign code, or with the add-on OFF", async () => {
    const before = await count("SELECT COALESCE(SUM(count), 0) AS n FROM affiliate_click_days");
    for (const ref of ["CLICKSUS", "NOBODY", "x", "CLICKOFF", "bad%20code!"]) {
      expect((await seo(`?path=%2F&ref=${ref}`)).status, ref).toBe((await seo("?path=%2F")).status);
    }
    await seo("?path=%2F&ref=CLICKOFF", OFF_HOST);
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM affiliate_click_days")).toBe(before);
    expect(await clicksOf(suspendedId)).toBe(0);
    expect(await clicksOf(offId)).toBe(0);
    // The add-on switched off stops the count of an otherwise counted code.
    await setFeature(SHOP, "affiliate", false);
    await seo("?path=%2F&ref=CLICK1");
    await setFeature(SHOP, "affiliate", true);
    expect(await clicksOf(activeId)).toBe(1);
  });

  it("refuses two refs as it refuses any malformed query; counts no forward", async () => {
    expect((await seo("?path=%2F&ref=CLICK1&ref=CLICK1")).status).toBe(400);
    await env.DB.prepare(
      `INSERT INTO redirects (tenant_id, from_path, to_path, created_at, created_by)
       VALUES (?, '/gammal', '/ny', '2026-10-22T00:00:00.000Z', 'test')`,
    )
      .bind(SHOP)
      .run();
    const before = await clicksOf(activeId);
    const forward = await seo("?path=%2Fgammal&ref=CLICK1");
    expect(await forward.json()).toEqual({ redirect: { status: 301, to: "/ny" } });
    expect(await clicksOf(activeId)).toBe(before);
  });

  it("a reload loop counts at most the limit per visitor and window", async () => {
    const before = await clicksOf(activeId);
    for (let index = 0; index < AFFILIATE_REF_LIMIT + 5; index += 1) {
      await seo("?path=%2F&ref=CLICK1", HOST, "198.51.100.99");
    }
    expect((await clicksOf(activeId)) - before).toBe(AFFILIATE_REF_LIMIT);
  });

  it("parses the code as the storefront does", () => {
    expect(parseRefParam(" sara-25 ")).toBe("SARA-25");
    expect(parseRefParam("ab")).toBeNull();
    expect(parseRefParam(null)).toBeNull();
  });
});

describe("the web Worker carries the ref (GET page landings only)", () => {
  const SHELL = `<!doctype html><html><head><title>S</title></head><body><div id="root"></div></body></html>`;

  function assets(): AssetsBinding {
    return {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        return path === "/index.html"
          ? new Response(SHELL, { headers: { "content-type": "text/html" } })
          : path === "/assets/app.js"
            ? new Response("1", { headers: { "content-type": "text/javascript" } })
            : new Response("missing", { status: 404 });
      },
    };
  }

  function spy(answer: (request: Request) => Response): { api: ApiBinding; urls: string[] } {
    const urls: string[] = [];
    const record = async (request: Request) => {
      urls.push(request.url);
      return answer(request);
    };
    return { api: { fetch: record, fetchForShop: async (_shop, request) => record(request) }, urls };
  }

  function webEnv(api: ApiBinding): WebEnv {
    return { API: api, ASSETS: assets(), PUBLIC_OBJECT_BASE_URL: "https://pub.test.invalid", WEB_ORIGIN } as WebEnv;
  }

  function navigation(url: string, method = "GET"): Request {
    return new Request(url, { headers: { accept: "text/html" }, method });
  }

  const page = () => Response.json({ page: { title: "T" } });

  it("a GET page landing puts &ref=CODE on its one SEO call, normalized", async () => {
    const { api, urls } = spy(page);
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP}/product/t?ref=sara-25&utm=x`), webEnv(api));
    expect(response.status).toBe(200);
    const seoCalls = urls.filter((url) => new URL(url).pathname === "/v1/seo");
    expect(seoCalls).toHaveLength(1);
    expect(new URL(seoCalls[0] ?? "").searchParams.getAll("ref")).toEqual(["SARA-25"]);
  });

  it("a HEAD, an asset, a page without ref, or with two refs carries none", async () => {
    for (const [url, method] of [
      [`${WEB_ORIGIN}/${SHOP}/?ref=SARA-25`, "HEAD"],
      [`${WEB_ORIGIN}/${SHOP}/`, "GET"],
      [`${WEB_ORIGIN}/${SHOP}/?ref=A1B&ref=C2D`, "GET"],
      [`${WEB_ORIGIN}/${SHOP}/?ref=no`, "GET"],
    ] as const) {
      const { api, urls } = spy(page);
      await handleRequest(navigation(url, method), webEnv(api));
      expect(urls.some((called) => new URL(called).searchParams.has("ref")), `${method} ${url}`).toBe(false);
    }
    const { api, urls } = spy(page);
    await handleRequest(new Request(`${WEB_ORIGIN}/assets/app.js?ref=SARA-25`), webEnv(api));
    expect(urls.some((called) => called.includes("ref="))).toBe(false);
    expect(landingRef("POST", new URL("https://x.test/?ref=SARA-25"))).toBeNull();
  });

  it("a forward keeps the ref on its Location (the page it leads to is the landing)", async () => {
    const { api } = spy(() => Response.json({ redirect: { status: 301, to: "/product/ny" } }));
    const response = await handleRequest(navigation(`${WEB_ORIGIN}/${SHOP}/product/gammal?ref=sara-25`), webEnv(api));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/${SHOP}/product/ny?ref=SARA-25`);
  });
});
