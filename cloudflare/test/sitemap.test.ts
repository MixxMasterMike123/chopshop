import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { decodeSitemapCursor, encodeSitemapCursor } from "../src/storefront/sitemap";
import {
  adoptLegalPages,
  ensureStorefrontTables,
  seedCollection,
  seedPage,
  seedProduct,
  seedShop,
  type SeededShop,
} from "./storefront-fixtures";

/**
 * CP4-D — GET /v1/sitemap: every public address of a shop, relative to its
 * root, at most 5 000 per answer, walked by a keyset cursor.
 */

interface SitemapBody {
  entries: Array<{ lastModified: string | null; path: string }>;
  nextCursor: string | null;
}

const PRODUCT_COUNT = 250;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let shop: SeededShop;
let other: SeededShop;
const productIds: string[] = [];

function sitemapRequest(origin: string, query = "", method = "GET"): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}/v1/sitemap${query}`, { method }));
}

async function sitemap(query = "", target: SeededShop = shop): Promise<SitemapBody> {
  const response = await sitemapRequest(target.origin, query);
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text) as SitemapBody;
}

async function walk(limit: number, between?: (page: number, seen: string[]) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const query: string = `?limit=${limit}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const body: SitemapBody = await sitemap(query);
    expect(body.entries.length).toBeLessThanOrEqual(limit);
    seen.push(...body.entries.map((entry) => entry.path));
    cursor = body.nextCursor;
    page += 1;
    if (between !== undefined) {
      await between(page, seen);
    }
  } while (cursor !== null && page < 50);
  expect(cursor).toBeNull();
  return seen;
}

beforeAll(async () => {
  await ensureStorefrontTables();
  shop = await seedShop("sm-shop");
  other = await seedShop("sm-other");
  for (let index = 0; index < PRODUCT_COUNT; index += 1) {
    productIds.push(
      await seedProduct(shop.tenantId, {
        category: index === 0 ? "Rökt" : index === 1 ? "rokt" : index === 2 ? "Tröjor" : null,
        handle: `vara-${String(index).padStart(3, "0")}`,
        name: `Vara ${index}`,
        sku: `SM-${index}`,
        tags: index === 3 ? ["Nyhet", "Rea"] : [],
      }),
    );
  }
  await seedProduct(shop.tenantId, { category: "Dold", handle: "utkast", name: "Utkast", published: false, sku: "SM-DRAFT", tags: ["Dold"] });
  await seedProduct(shop.tenantId, { handle: "nedtagen", name: "Nedtagen", sku: "SM-DOWN", takenDown: true });
  await seedProduct(shop.tenantId, { handle: "arkiv", name: "Arkiv", sku: "SM-ARCHIVED", status: "archived" });
  await seedProduct(other.tenantId, { handle: "annans", name: "Annans", sku: "SM-OTHER" });
  await seedCollection(shop.tenantId, { handle: "nytt", title: "Nytt" });
  await seedCollection(shop.tenantId, { handle: "dold-samling", published: false, title: "Dold" });
  await seedCollection(other.tenantId, { handle: "annans-samling", title: "Annans" });
  await seedPage(shop.tenantId, { content: "<p>x</p>", slug: "om-oss", title: "Om oss" });
  await seedPage(shop.tenantId, { content: "<p>x</p>", kind: "post", slug: "nyhet-ett", title: "Nyhet" });
  await seedPage(shop.tenantId, { content: "<p>x</p>", slug: "utkast-sida", status: "draft", title: "Utkast" });
  await adoptLegalPages(shop.tenantId, { kopvillkor: "<p>Villkor</p>" });
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals", () => {
  it.each([
    ["another parameter", "?page=2"],
    ["two cursors", "?cursor=0.&cursor=0."],
    ["a cursor of another section", "?cursor=9.Lw"],
    ["a cursor that is not base64url", "?cursor=1.%40%40"],
    ["a cursor without a section", "?cursor=Lw"],
    ["a cursor that is not UTF-8", "?cursor=1.wyg"],
    ["an overlong cursor", `?cursor=1.${"A".repeat(600)}`],
    ["limit 0", "?limit=0"],
    ["limit 5001", "?limit=5001"],
    ["a text limit", "?limit=all"],
    ["a negative limit", "?limit=-1"],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await sitemapRequest(shop.origin, query);
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("answers 404 for an unknown host, an unpublished and a suspended shop, and another method", async () => {
    const unpublished = await seedShop("sm-unpublished", { published: false });
    const suspended = await seedShop("sm-suspended", { status: "suspended" });
    for (const origin of ["https://nobody.storefront-d.test", unpublished.origin, suspended.origin]) {
      const response = await sitemapRequest(origin);
      expect(response.status, origin).toBe(404);
      await response.body?.cancel();
    }
    for (const method of ["POST", "HEAD"]) {
      const response = await sitemapRequest(shop.origin, "", method);
      expect(response.status, method).toBe(404);
      await response.body?.cancel();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the entries", () => {
  it("lists every public address once, and nothing else, in one answer", async () => {
    const response = await sitemapRequest(shop.origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SitemapBody;
    expect(body.nextCursor).toBeNull();
    const paths = body.entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);

    const expectedProducts = Array.from({ length: PRODUCT_COUNT }, (_, i) => `/product/vara-${String(i).padStart(3, "0")}`);
    expect(paths.slice(0, 2)).toEqual(["/", "/produkter"]);
    expect(paths.filter((path) => path.startsWith("/product/")).sort()).toEqual(expectedProducts);
    expect(paths.slice(2 + PRODUCT_COUNT)).toEqual([
      "/samling/nytt",
      "/kategori/rokt", // "Rökt" and "rokt" share one address
      "/kategori/trojor",
      "/tagg/nyhet",
      "/tagg/rea",
      ...paths.slice(2 + PRODUCT_COUNT + 5, 2 + PRODUCT_COUNT + 7),
      "/legal/kopvillkor",
      "/legal/plattformsvillkor",
    ]);
    expect(paths.slice(2 + PRODUCT_COUNT + 5, 2 + PRODUCT_COUNT + 7).sort()).toEqual(["/nyhet-ett", "/om-oss"]);
    for (const hidden of ["utkast", "nedtagen", "arkiv", "annans", "dold", "utkast-sida", "angerratt", "integritetspolicy"]) {
      expect(paths.some((path) => path.includes(hidden)), hidden).toBe(false);
    }

    const byPath = new Map(body.entries.map((entry) => [entry.path, entry.lastModified]));
    expect(byPath.get("/")).toBeNull();
    expect(byPath.get("/kategori/rokt")).toBeNull();
    expect(byPath.get("/product/vara-000")).toMatch(ISO);
    expect(byPath.get("/samling/nytt")).toMatch(ISO);
    expect(byPath.get("/om-oss")).toMatch(ISO);
    expect(byPath.get("/legal/kopvillkor")).toMatch(ISO);
    expect(byPath.get("/legal/plattformsvillkor")).toBe("2026-09-07T00:00:00.000Z");
  });

  it("gives another shop only its own addresses", async () => {
    const body = await sitemap("", other);
    expect(body.entries.map((entry) => entry.path)).toEqual([
      "/",
      "/produkter",
      "/product/annans",
      "/samling/annans-samling",
      "/legal/plattformsvillkor",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the keyset cursor", () => {
  it("walks the whole sitemap in pages of 100 with no gap and no repeat", async () => {
    const whole = (await sitemap()).entries.map((entry) => entry.path);
    const walked = await walk(100);
    expect(walked).toEqual(whole);
  });

  it("walks pages of 7 as well", async () => {
    const whole = (await sitemap()).entries.map((entry) => entry.path);
    expect(await walk(7)).toEqual(whole);
  });

  it("stays whole while a product is unpublished in between: the product leaves, nothing repeats, nothing else is lost", async () => {
    const whole = (await sitemap()).entries.map((entry) => entry.path);
    let removed: string | null = null;
    const walked = await walk(100, async (page, seen) => {
      if (page !== 1) {
        return;
      }
      // A product the walk has not reached yet.
      const index = productIds.findIndex((_, i) => !seen.includes(`/product/vara-${String(i).padStart(3, "0")}`));
      removed = `/product/vara-${String(index).padStart(3, "0")}`;
      await env.DB.prepare("UPDATE product_publications SET published = 0, published_at = published_at WHERE product_id = ?")
        .bind(productIds[index] as string)
        .run();
    });
    expect(removed).not.toBeNull();
    expect(walked).toEqual(whole.filter((path) => path !== removed));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("encodes and decodes a cursor, and refuses one it did not write", () => {
    const cursor = { after: "prod-å-😀", section: 3 };
    expect(decodeSitemapCursor(encodeSitemapCursor(cursor))).toEqual(cursor);
    expect(decodeSitemapCursor("7.Lw")).toBeNull();
    expect(decodeSitemapCursor("3.Lw==")).toBeNull();
    expect(decodeSitemapCursor("3")).toBeNull();
  });
});
