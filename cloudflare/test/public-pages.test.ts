import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ObjectKind } from "../src/storage/object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  reservePendingObject,
} from "../src/storage/object-store";
import { ADMIN, call, type CallOptions, createTenant } from "./slice-harness";
import { expectJson, platform, SliceWorld, type Tenant, tenantWorld } from "./tenant-fixtures";

/**
 * CP4-C — the storefront's content pages and posts (GET /v1/pages,
 * GET /v1/pages/:slug). The tenant is the hostname; only a PUBLISHED page of
 * an ACTIVE, PUBLISHED shop answers; the ETag is the shop's catalog_version.
 */

const NOW = 1_790_000_000_000;
const PUBLIC_BASE = "https://public-objects.test.invalid";
const NOT_FOUND = { error: { code: "not_found", message: "Page not found" } };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let shopC: Tenant;

interface PublicPage {
  author: string | null;
  content: string;
  image: { contentType: string; height: number | null; objectId: string; url: string; width: number | null } | null;
  kind: string;
  lang: string;
  metaDescription: string | null;
  metaTitle: string | null;
  path: string;
  publishedAt: string;
  slug: string;
  summary: string | null;
  title: string;
  updatedAt: string;
}

interface PublicListItem {
  author: string | null;
  image: PublicPage["image"];
  kind: string;
  path: string;
  publishedAt: string;
  slug: string;
  summary: string | null;
  title: string;
}

function admin(tenant: Tenant, method: string, path: string, body?: unknown) {
  return call(world, method, `${ADMIN}${path}`, { body, cookie: tenant.adminCookie, shopId: tenant.tenantId });
}

async function create(tenant: Tenant, body: Record<string, unknown>): Promise<{ pageId: string; publishedAt: string | null }> {
  return (
    await expectJson<{ page: { pageId: string; publishedAt: string | null } }>(
      await admin(tenant, "POST", "/v1/admin/pages", body),
      201,
      `create ${String(body.slug)}`,
    )
  ).page;
}

async function patch(tenant: Tenant, pageId: string, body: Record<string, unknown>): Promise<void> {
  await expectJson(await admin(tenant, "PATCH", `/v1/admin/pages/${pageId}`, body), 200, `patch ${pageId}`);
}

function visit(tenant: Tenant, path: string, options: CallOptions = {}): Promise<Response> {
  return call(world, "GET", `${tenant.origin}${path}`, options);
}

async function readPage(tenant: Tenant, path: string): Promise<PublicPage> {
  return (await expectJson<{ page: PublicPage }>(await visit(tenant, path), 200, path)).page;
}

async function expectPageNotFound(response: Response, label: string): Promise<void> {
  expect(await expectJson(response, 404, label), label).toEqual(NOT_FOUND);
  expect(response.headers.get("etag"), label).toBeNull();
}

async function publicImage(tenant: Tenant, kind: ObjectKind = "product_media"): Promise<string> {
  const context = { domainKind: "admin", hostname: "", tenantId: tenant.tenantId };
  const reserved = await reservePendingObject(
    env.DB,
    context,
    { bucket: "public", contentType: "image/png", fileName: "omslag.png", kind },
    NOW,
  );
  if (reserved.status !== "ok") {
    throw new Error("reserve failed");
  }
  await activateObject(
    env.DB,
    context,
    reserved.object.objectId,
    { dimensions: { height: 600, width: 800 }, sha256: "d".repeat(64), sizeBytes: 4_096 },
    NOW,
  );
  return reserved.object.objectId;
}

beforeAll(async () => {
  const setup = await tenantWorld("pp", 3);
  world = setup.world;
  [shopA, shopB, shopC] = setup.tenants as [Tenant, Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one page by slug", () => {
  let imageId: string;

  beforeAll(async () => {
    imageId = await publicImage(shopA);
    await create(shopA, {
      author: "Kent",
      content: { "en-US": "<p>About us</p>", "sv-SE": "<h2>Om oss</h2><p>Vi är ett band.</p>" },
      imageObjectId: imageId,
      metaDescription: { "sv-SE": "Beskrivning" },
      metaTitle: { "sv-SE": "Om oss | Butiken" },
      slug: "om-oss",
      status: "published",
      summary: { "sv-SE": "Kort om oss" },
      title: { "en-US": "About us", "sv-SE": "Om oss" },
    });
    await create(shopA, {
      content: { "sv-SE": "<p>Hemligt utkast</p>" },
      slug: "utkast",
      title: { "sv-SE": "Utkast" },
    });
    await create(shopB, {
      content: { "sv-SE": "<p>B:s egen sida</p>" },
      slug: "om-oss",
      status: "published",
      title: { "sv-SE": "B om oss" },
    });
  });

  it("answers the published page in the shop's default language, with its public fields only", async () => {
    const response = await visit(shopA, "/v1/pages/om-oss");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^"\d+"$/);

    const body = JSON.parse(text) as { page: PublicPage };
    expect(body).toEqual({
      page: {
        author: "Kent",
        content: "<h2>Om oss</h2><p>Vi är ett band.</p>",
        image: {
          contentType: "image/png",
          height: 600,
          objectId: imageId,
          url: `${PUBLIC_BASE}/shops/${shopA.tenantId}/product_media/${imageId}/v1/omslag.png`,
          width: 800,
        },
        kind: "page",
        lang: "sv-SE",
        metaDescription: "Beskrivning",
        metaTitle: "Om oss | Butiken",
        path: "/om-oss",
        publishedAt: expect.stringMatching(ISO),
        slug: "om-oss",
        summary: "Kort om oss",
        title: "Om oss",
        updatedAt: expect.stringMatching(ISO),
      },
    });
    // Nothing of the admin's: no row id, no status, no actor, no tenant key.
    // (The image's address carries its key, which names the shop: P's key
    // grammar, public by design.)
    expect(text).not.toMatch(/"(pageId|page_id|status|createdBy|updatedBy|created_by|tenantId|imageObjectId)"/);
    expect(text).not.toContain(shopA.adminUserId);
  });

  it("a draft, an unknown slug and a malformed slug are the same 404", async () => {
    await expectPageNotFound(await visit(shopA, "/v1/pages/utkast"), "draft");
    await expectPageNotFound(await visit(shopA, "/v1/pages/finns-inte"), "unknown");
    await expectPageNotFound(await visit(shopA, "/v1/pages/Om-Oss"), "upper case");
    await expectPageNotFound(await visit(shopA, "/v1/pages/%ZZ"), "bad escape");
    await expectPageNotFound(await visit(shopA, "/v1/pages/om%2Foss"), "encoded slash");
    await expectPageNotFound(await visit(shopA, `/v1/pages/${"a".repeat(101)}`), "too long");
    // Decoded once: an escaped letter is the letter.
    expect((await readPage(shopA, "/v1/pages/om%2Doss")).title).toBe("Om oss");
  });

  it("each shop reads only its own page: the host decides, never a header", async () => {
    expect((await readPage(shopB, "/v1/pages/om-oss")).content).toBe("<p>B:s egen sida</p>");
    await expectPageNotFound(await visit(shopC, "/v1/pages/om-oss"), "C has none");
    const spoofed = await visit(shopC, "/v1/pages/om-oss", {
      headers: { "x-forwarded-host": shopA.host, "x-shop-id": shopA.tenantId },
    });
    expect(spoofed.status).toBe(404);
    await spoofed.body?.cancel();
    await expectPageNotFound(
      await call(world, "GET", "https://unknown.shops.cp4c.test/v1/pages/om-oss"),
      "unknown host",
    );
  });

  it("`lang` picks the page's text in that language, else the shop's default; never another page's", async () => {
    expect(await readPage(shopA, "/v1/pages/om-oss?lang=en-US")).toMatchObject({
      content: "<p>About us</p>",
      lang: "en-US",
      // Per text: the summary and meta texts exist in Swedish only.
      metaTitle: "Om oss | Butiken",
      summary: "Kort om oss",
      title: "About us",
    });
    for (const lang of ["de-DE", "xx_YY", "", "sv-se", "en"]) {
      expect(await readPage(shopA, `/v1/pages/om-oss?lang=${encodeURIComponent(lang)}`), lang).toMatchObject({
        content: "<h2>Om oss</h2><p>Vi är ett band.</p>",
        lang: "sv-SE",
        title: "Om oss",
      });
    }

    // A page with no text in the default language answers its first language.
    await create(shopA, {
      content: { "en-US": "<p>English only</p>" },
      slug: "english",
      status: "published",
      title: { "en-US": "English" },
    });
    expect(await readPage(shopA, "/v1/pages/english")).toMatchObject({
      content: "<p>English only</p>",
      lang: "en-US",
      title: "English",
    });
  });

  it("the shop's default language comes from the shop, and a change of it changes the ETag", async () => {
    const before = await visit(shopA, "/v1/pages/om-oss");
    const etag = before.headers.get("etag");
    await before.body?.cancel();

    await env.DB.prepare("UPDATE tenants SET default_locale = 'en-US' WHERE tenant_id = ?").bind(shopA.tenantId).run();
    try {
      const after = await visit(shopA, "/v1/pages/om-oss", { headers: { "if-none-match": etag ?? "" } });
      expect(after.status).toBe(200);
      expect(((await after.json()) as { page: PublicPage }).page).toMatchObject({ lang: "en-US", title: "About us" });
    } finally {
      await env.DB.prepare("UPDATE tenants SET default_locale = 'sv-SE' WHERE tenant_id = ?").bind(shopA.tenantId).run();
    }
  });

  it("answers If-None-Match with a bodiless 304 until the page changes", async () => {
    const first = await visit(shopA, "/v1/pages/om-oss");
    const etag = first.headers.get("etag") ?? "";
    await first.body?.cancel();

    const cached = await visit(shopA, "/v1/pages/om-oss", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("etag")).toBe(etag);

    const row = await env.DB.prepare("SELECT page_id FROM pages WHERE tenant_id = ? AND slug = 'om-oss'")
      .bind(shopA.tenantId)
      .first<{ page_id: string }>();
    await patch(shopA, row?.page_id ?? "", { summary: { "sv-SE": "Ny sammanfattning" } });

    const changed = await visit(shopA, "/v1/pages/om-oss", { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(((await changed.json()) as { page: PublicPage }).page.summary).toBe("Ny sammanfattning");
  });

  it("a removed image (D93) shows as none, and the ETag moves", async () => {
    const coverId = await publicImage(shopA);
    await create(shopA, {
      content: { "sv-SE": "<p>Med bild</p>" },
      imageObjectId: coverId,
      slug: "med-bild",
      status: "published",
      title: { "sv-SE": "Med bild" },
    });
    const first = await visit(shopA, "/v1/pages/med-bild");
    const etag = first.headers.get("etag") ?? "";
    expect(((await first.json()) as { page: PublicPage }).page.image?.objectId).toBe(coverId);

    await deletePendingOrMutableObject(
      env.DB,
      { domainKind: "admin", hostname: "", tenantId: shopA.tenantId },
      coverId,
      NOW,
    );
    const after = await visit(shopA, "/v1/pages/med-bild", { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { page: PublicPage }).page.image).toBeNull();
  });

  it("no image without a configured public address", async () => {
    const response = await call(world, "GET", `${shopA.origin}/v1/pages/om-oss`, {
      env: world.with({ PUBLIC_OBJECT_BASE_URL: undefined }),
    });
    expect(((await response.json()) as { page: PublicPage }).page.image).toBeNull();
  });

  it("answers GET only, with one `lang` and nothing else", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const response = await call(world, method, `${shopA.origin}/v1/pages/om-oss`, { body: method === "HEAD" ? undefined : {} });
      expect(response.status, method).toBe(404);
      await response.body?.cancel();
    }
    for (const query of ["?x=1", "?lang=sv-SE&lang=en-US", "?kind=post"]) {
      await expectJson(await visit(shopA, `/v1/pages/om-oss${query}`), 400, query);
    }
    const trailing = await visit(shopA, "/v1/pages/om-oss/extra");
    expect(trailing.status).toBe(404);
    await trailing.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the list of published pages and posts", () => {
  let shop: Tenant;
  const posts: Array<{ pageId: string; slug: string }> = [];

  beforeAll(async () => {
    shop = await createTenant(world, {
      host: "pp-list.shops.cp4c.test",
      legallyReady: false,
      shopName: "Butik pp-list",
      tenantId: "pp-list",
    });
    // 25 posts on distinct dates (a post's date is its own, set by the admin
    // or the importer), 3 pages, 2 drafts.
    for (let index = 0; index < 25; index += 1) {
      const slug = `inlagg-${String(index).padStart(2, "0")}`;
      const created = await create(shop, {
        author: index % 2 === 0 ? "Kent" : null,
        content: { "sv-SE": `<p>${slug}</p>` },
        kind: "post",
        publishedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        slug,
        status: "published",
        summary: { "sv-SE": `Om ${slug}` },
        title: { "en-US": `Post ${index}`, "sv-SE": `Inlägg ${index}` },
      });
      posts.push({ pageId: created.pageId, slug });
    }
    for (const slug of ["kontakt", "faq", "leverans"]) {
      await create(shop, { content: { "sv-SE": "<p>x</p>" }, slug, status: "published", title: { "sv-SE": slug } });
    }
    for (const slug of ["utkast-1", "utkast-2"]) {
      await create(shop, { content: { "sv-SE": "<p>x</p>" }, kind: "post", slug, title: { "sv-SE": slug } });
    }
  }, 120_000);

  async function list(query: string): Promise<{ nextCursor: string | null; pages: PublicListItem[] }> {
    return expectJson(await visit(shop, `/v1/pages${query}`), 200, query);
  }

  it("lists posts newest first with the list shape, and never a draft", async () => {
    const body = await list("?kind=post&limit=3");
    expect(body.pages.map((page) => page.slug)).toEqual(["inlagg-24", "inlagg-23", "inlagg-22"]);
    expect(body.pages[0]).toEqual({
      author: "Kent",
      image: null,
      kind: "post",
      path: "/inlagg-24",
      publishedAt: "2026-01-25T00:00:00.000Z",
      slug: "inlagg-24",
      summary: "Om inlagg-24",
      title: "Inlägg 24",
    });
    expect(body.pages[1]?.author).toBeNull();
    expect(body.nextCursor).toBe(`2026-01-23T00:00:00.000Z~${posts[22]?.pageId}`);

    const everything = await list("?limit=100");
    expect(everything.pages).toHaveLength(28);
    expect(everything.nextCursor).toBeNull();
    expect(everything.pages.map((page) => page.slug)).not.toContain("utkast-1");
    expect((await list("?kind=page")).pages.map((page) => page.slug).sort()).toEqual(["faq", "kontakt", "leverans"]);
    expect((await list("?kind=post&lang=en-US&limit=1")).pages[0]?.title).toBe("Post 24");
  });

  it("the cursor walks every post once while one is unpublished between two reads", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const query: string = `?kind=post&limit=10${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const body = await list(query);
      seen.push(...body.pages.map((page) => page.slug));
      if (rounds === 0) {
        // A post the next read would have shown goes back to draft.
        await patch(shop, posts[10]?.pageId ?? "", { status: "draft" });
      }
      cursor = body.nextCursor;
      rounds += 1;
    } while (cursor !== null && rounds < 10);

    expect(rounds).toBe(3);
    expect(seen).toHaveLength(24);
    expect(new Set(seen).size).toBe(24);
    expect(seen).not.toContain("inlagg-10");
    expect(seen).toEqual(
      posts
        .map((post) => post.slug)
        .filter((slug) => slug !== "inlagg-10")
        .reverse(),
    );
    await patch(shop, posts[10]?.pageId ?? "", { status: "published" });
  });

  it("carries the ETag of the shop and a 304 while nothing changed", async () => {
    const first = await visit(shop, "/v1/pages?kind=post");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"\d+"$/);
    await first.body?.cancel();
    const cached = await visit(shop, "/v1/pages?kind=post", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
    await cached.body?.cancel();

    await create(shop, { content: { "sv-SE": "<p>x</p>" }, kind: "post", slug: "utkast-3", title: { "sv-SE": "x" } });
    const moved = await visit(shop, "/v1/pages?kind=post", { headers: { "if-none-match": etag } });
    expect(moved.status).toBe(200);
    await moved.body?.cancel();
  });

  it.each([
    ["an unknown parameter", "?page=2"],
    ["a repeated parameter", "?kind=post&kind=page"],
    ["an unknown kind", "?kind=legal"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a negative limit", "?limit=-1"],
    ["a malformed cursor", "?cursor=abc"],
    ["a cursor with an id of the wrong grammar", `?cursor=${encodeURIComponent("2026-01-01T00:00:00.000Z~a/b")}`],
  ])("refuses %s with 400", async (_label, query) => {
    await expectJson(await visit(shop, `/v1/pages${query}`), 400, query);
  });

  it("an empty shop answers an empty list", async () => {
    expect(await expectJson(await visit(shopC, "/v1/pages"), 200, "empty")).toEqual({ nextCursor: null, pages: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a shop that is not public answers no page", () => {
  it("unpublished: 404 on the page and the list; published again: back", async () => {
    await create(shopB, {
      content: { "sv-SE": "<p>Synlig</p>" },
      slug: "synlig",
      status: "published",
      title: { "sv-SE": "Synlig" },
    });
    expect((await readPage(shopB, "/v1/pages/synlig")).content).toBe("<p>Synlig</p>");

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/unpublish`),
      200,
      "unpublish",
    );
    await expectPageNotFound(await visit(shopB, "/v1/pages/synlig"), "page of an unpublished shop");
    await expectPageNotFound(await visit(shopB, "/v1/pages"), "list of an unpublished shop");

    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/publish`), 200, "publish");
    expect((await readPage(shopB, "/v1/pages/synlig")).content).toBe("<p>Synlig</p>");
  });

  it("suspended: 404 on the page and the list; active again: back", async () => {
    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/suspend`), 200, "suspend");
    await expectPageNotFound(await visit(shopB, "/v1/pages/synlig"), "page of a suspended shop");
    await expectPageNotFound(await visit(shopB, "/v1/pages"), "list of a suspended shop");

    await expectJson(await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/activate`), 200, "activate");
    expect((await readPage(shopB, "/v1/pages/synlig")).content).toBe("<p>Synlig</p>");
  });
});
