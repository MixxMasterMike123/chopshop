import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BODY_HTML_MAX,
  escapeHtml,
  htmlToText,
  legalPageTexts,
  parseStorefrontRoute,
  resolveSeoAnswer,
  truncateDescription,
} from "../src/storefront/seo";
import {
  adoptLegalPages,
  attachImage,
  ensureStorefrontTables,
  objectKey,
  PUBLIC_BASE,
  publicObject,
  publishPlatformTerms,
  removeObject,
  seedCollection,
  seedPage,
  seedProduct,
  seedShop,
  type SeededShop,
  storeIdentity,
} from "./storefront-fixtures";

/**
 * CP4-D — GET /v1/seo?path= (D88): one answer per navigation — a forward, a
 * page's head and readable body, or 404 — built from public fields only.
 */

interface SeoPageBody {
  page: {
    bodyHtml: string;
    canonicalPath: string;
    description: string | null;
    image: { height: number | null; objectId: string; url: string; width: number | null } | null;
    jsonLd: Record<string, unknown>;
    robots: string | null;
    title: string;
  };
}

const HOSTILE = `</title><script>alert("x")</script>`;

let shop: SeededShop;
let other: SeededShop;
const products: Record<string, string> = {};
let logo: string;
let hero: string;
let firstImage: string;
let secondImage: string;

function seoRequest(origin: string, query: string, method = "GET"): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}/v1/seo${query}`, { method }));
}

async function seoPage(path: string, target: SeededShop = shop): Promise<SeoPageBody["page"]> {
  const response = await seoRequest(target.origin, `?path=${encodeURIComponent(path)}`);
  const text = await response.text();
  expect(response.status, `${path}: ${text.slice(0, 300)}`).toBe(200);
  const body = JSON.parse(text) as Partial<SeoPageBody>;
  if (body.page === undefined) {
    throw new Error(`${path} answered ${text.slice(0, 200)}`);
  }
  return body.page;
}

async function seoStatus(path: string, target: SeededShop = shop): Promise<number> {
  const response = await seoRequest(target.origin, `?path=${encodeURIComponent(path)}`);
  await response.body?.cancel();
  return response.status;
}

/** Every `{ "@relative": … }` in the JSON-LD: an object of that ONE key and a root-relative path. */
function relatives(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => relatives(item, found));
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "@relative")) {
      expect(Object.keys(record)).toEqual(["@relative"]);
      expect(record["@relative"]).toMatch(/^\/(?![/\\])[A-Za-z0-9\-._~%/]*$/);
      found.push(record["@relative"] as string);
    } else {
      Object.values(record).forEach((item) => relatives(item, found));
    }
  }
  return found;
}

beforeAll(async () => {
  await ensureStorefrontTables();
  shop = await seedShop("seo-shop", { name: `Kläder & "Co"`, supportEmail: "hej@klader.test" });
  other = await seedShop("seo-other");
  logo = await publicObject(shop.tenantId, { fileName: "logo.png" });
  hero = await publicObject(shop.tenantId, { fileName: "hero.png" });
  firstImage = await publicObject(shop.tenantId, { fileName: "first.png", kind: "product_media" });
  secondImage = await publicObject(shop.tenantId, { fileName: "second.png", kind: "product_media", size: null });

  products.mug = await seedProduct(shop.tenantId, {
    category: "Rökt & Gott",
    description: "En mugg.\n\nMed <b>två</b> stycken & mer.",
    handle: "mugg",
    name: "Mugg",
    priceMinor: 19_900,
    sku: "SEO-MUG",
    sortOrder: 1,
    tags: ["Nyhet"],
  });
  products.tee = await seedProduct(shop.tenantId, {
    category: "rokt and gott",
    handle: "tee",
    name: HOSTILE,
    priceMinor: 24_900,
    sku: "SEO-TEE",
    sortOrder: 2,
    tags: ["nyhet"],
    variants: [
      { label: "S", priceMinor: 14_900, sku: "SEO-TEE-S" },
      { label: "XL", priceMinor: 19_900, sku: "SEO-TEE-XL" },
      { active: false, label: "Gammal", priceMinor: 100, sku: "SEO-TEE-OLD" },
    ],
  });
  products.draft = await seedProduct(shop.tenantId, {
    category: "Utkast",
    handle: "utkast",
    name: "Utkastprodukt",
    published: false,
    sku: "SEO-DRAFT",
    tags: ["Hemlig"],
  });
  products.down = await seedProduct(shop.tenantId, {
    handle: "nedtagen",
    name: "Nedtagen",
    sku: "SEO-DOWN",
    takenDown: true,
  });
  products.foreign = await seedProduct(other.tenantId, { handle: "annans", name: "Annans", sku: "SEO-FOREIGN" });
  await attachImage(shop.tenantId, products.mug, firstImage, 0, "Muggen framifrån");
  await attachImage(shop.tenantId, products.mug, secondImage, 1, null);

  await seedCollection(shop.tenantId, {
    description: "Det nya",
    handle: "nytt",
    imageObjectId: firstImage,
    productIds: [products.tee as string, products.draft as string, products.mug as string],
    title: "Nytt",
  });
  await seedCollection(shop.tenantId, { handle: "smart", ruleTag: "NYHET", title: "Smart", type: "smart" });
  await seedCollection(shop.tenantId, { handle: "dold", published: false, title: "Dold" });

  await seedPage(shop.tenantId, {
    content: `<h2>Vi</h2><script>alert(1)</script><p>Hej <b>du</b> &amp; jag</p><!-- <p>kommentar</p> --><style>p{color:red}</style>`,
    metaDescription: "Allt om oss",
    metaTitle: "Om oss – Kläder",
    slug: "om-oss",
    title: "Om oss",
  });
  await seedPage(shop.tenantId, {
    author: "Kim",
    content: "<p>Första inlägget.</p>",
    kind: "post",
    slug: "forsta-inlagget",
    summary: "Kort om det",
    title: "Första inlägget",
  });
  await seedPage(shop.tenantId, { content: "<p>Utkast</p>", slug: "utkast-sida", status: "draft", title: "Utkast" });

  await storeIdentity(shop.tenantId, {
    companyDescription: "Kläder tryckta i Sverige.",
    heroHeadline: HOSTILE,
    heroObjectId: hero,
    introBody: "Stycke ett.\n\nStycke <två>.",
    logoObjectId: logo,
    menu: [
      { label: "Nytt", target: "nytt", type: "collection" },
      { label: "Om oss", target: "om-oss", type: "page" },
      { label: "Extern", target: "https://extern.test", type: "url" },
    ],
    returnAddress: "must-not-appear",
    social: { instagram: "https://instagram.test/klader", tiktok: "javascript:x" },
    tagline: "Tryck & tröjor",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals", () => {
  it.each([
    ["no path", ""],
    ["two paths", "?path=%2F&path=%2Fx"],
    ["another parameter", "?path=%2F&tenant=seo-other"],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await seoRequest(shop.origin, query);
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("answers 404 for an unknown host, an unpublished and a suspended shop", async () => {
    const unpublished = await seedShop("seo-unpublished", { published: false });
    const suspended = await seedShop("seo-suspended", { status: "suspended" });
    for (const origin of ["https://nobody.storefront-d.test", unpublished.origin, suspended.origin]) {
      const response = await seoRequest(origin, "?path=%2F");
      expect(response.status, origin).toBe(404);
      await response.body?.cancel();
    }
  });

  it("answers another method with 404", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await seoRequest(shop.origin, "?path=%2F", method);
      expect(response.status, method).toBe(404);
      await response.body?.cancel();
    }
  });

  it.each([
    ["the cart", "/cart"],
    ["checkout", "/checkout"],
    ["an order", "/order-confirmation/abc"],
    ["a deeper address", "/product/mugg/extra"],
    ["an unknown product", "/product/finns-inte"],
    ["a draft product", "/product/utkast"],
    ["a taken-down product", "/product/nedtagen"],
    ["another shop's product", "/product/annans"],
    ["an unknown category", "/kategori/inget"],
    ["a category of drafts only", "/kategori/utkast"],
    ["a tag of drafts only", "/tagg/hemlig"],
    ["an unpublished collection", "/samling/dold"],
    ["a draft page", "/utkast-sida"],
    ["an unknown page", "/finns-inte"],
    ["a legal page not adopted", "/legal/kopvillkor"],
    ["a malformed path", "/a%E0%A4%A"],
    ["a dot segment", "/%2e%2e/seo-other"],
    ["no leading slash", "product/mugg"],
  ])("answers 404 for %s", async (_label, path) => {
    expect(await seoStatus(path)).toBe(404);
  });

  it("answers no-store and no ETag", async () => {
    const response = await seoRequest(shop.origin, "?path=%2F");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    await response.body?.cancel();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("pages", () => {
  it("the home: title, description, image, the organisation, a readable body", async () => {
    const page = await seoPage("/");
    expect(page.title).toBe(`Kläder & "Co" - Tryck & tröjor`);
    expect(page.description).toBe("Kläder tryckta i Sverige.");
    expect(page.canonicalPath).toBe("/");
    expect(page.robots).toBeNull();
    expect(page.image?.url).toBe(`${PUBLIC_BASE}/${await objectKey(hero)}`);
    expect(page.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      contactPoint: { "@type": "ContactPoint", contactType: "customer service", email: "hej@klader.test" },
      description: "Kläder tryckta i Sverige.",
      logo: `${PUBLIC_BASE}/${await objectKey(logo)}`,
      name: `Kläder & "Co"`,
      sameAs: ["https://instagram.test/klader"],
      url: { "@relative": "/" },
    });
    expect(page.bodyHtml).toBe(
      `<h1>${escapeHtml(HOSTILE)}</h1><p>Tryck &amp; tröjor</p><p>Stycke ett.</p><p>Stycke &lt;två&gt;.</p>` +
        `<nav><ul><li><a href="/samling/nytt">Nytt</a></li><li><a href="/om-oss">Om oss</a></li>` +
        `<li><a href="/produkter">Alla produkter</a></li></ul></nav>`,
    );
    expect(page.bodyHtml).not.toContain("<script");
    expect(JSON.stringify(page)).not.toContain("must-not-appear");
    expect(JSON.stringify(page)).not.toContain("javascript:");
  });

  it("a product: its head, its offer, and a body a search engine reads", async () => {
    const page = await seoPage("/product/mugg");
    expect(page.title).toBe(`Mugg | Kläder & "Co"`);
    expect(page.description).toBe("En mugg. Med <b>två</b> stycken & mer.");
    expect(page.canonicalPath).toBe("/product/mugg");
    expect(page.image).toMatchObject({ objectId: firstImage, url: `${PUBLIC_BASE}/${await objectKey(firstImage)}` });
    expect(page.jsonLd).toMatchObject({
      "@type": "Product",
      category: "Rökt & Gott",
      image: [`${PUBLIC_BASE}/${await objectKey(firstImage)}`],
      name: "Mugg",
      offers: {
        "@type": "Offer",
        availability: "https://schema.org/InStock",
        price: "199.00",
        priceCurrency: "SEK",
        url: { "@relative": "/product/mugg" },
      },
      sku: "SEO-MUG",
      url: { "@relative": "/product/mugg" },
    });
    expect(page.bodyHtml).toMatch(/^<article><h1>Mugg<\/h1><p><img src="[^"]+" alt="Muggen framifrån" width="400" height="300"><\/p><p>199,00\skr<\/p>/);
    expect(page.bodyHtml).toContain("<p>En mugg.</p><p>Med &lt;b&gt;två&lt;/b&gt; stycken &amp; mer.</p>");
    expect(page.bodyHtml).toContain(`<a href="/kategori/rokt-and-gott">Rökt &amp; Gott</a>`);
    expect(relatives(page.jsonLd)).toEqual(["/product/mugg", "/product/mugg"]);
  });

  it("a product whose variants price differently: from the lowest, an AggregateOffer; its name stays text", async () => {
    const page = await seoPage("/product/tee");
    expect(page.jsonLd.offers).toEqual({
      "@type": "AggregateOffer",
      availability: "https://schema.org/InStock",
      highPrice: "199.00",
      lowPrice: "149.00",
      offerCount: 2,
      priceCurrency: "SEK",
      url: { "@relative": "/product/tee" },
    });
    expect(page.bodyHtml).toMatch(/<p>Från 149,00\skr<\/p>/);
    expect(page.bodyHtml).not.toContain("<script");
    expect(page.bodyHtml).toContain(escapeHtml(HOSTILE));
    expect(page.image).toBeNull();
  });

  it("a product whose first image was removed (D93) leads with the next one", async () => {
    await removeObject(shop.tenantId, firstImage);
    const page = await seoPage("/product/mugg");
    expect(page.image).toMatchObject({ height: null, objectId: secondImage, width: null });
    expect(page.bodyHtml).toContain(`alt="Mugg"`);
  });

  it("a category: every name of its address, public products only, in the shop's order", async () => {
    const page = await seoPage("/kategori/rokt-and-gott");
    expect(page.title).toBe(`Rökt & Gott | Kläder & "Co"`);
    expect(page.canonicalPath).toBe("/kategori/rokt-and-gott");
    expect(page.bodyHtml).toBe(
      `<h1>Rökt &amp; Gott</h1><ul><li><a href="/product/mugg">Mugg</a></li>` +
        `<li><a href="/product/tee">${escapeHtml(HOSTILE)}</a></li></ul>`,
    );
    expect(page.jsonLd).toMatchObject({
      "@type": "CollectionPage",
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", name: "Mugg", position: 1, url: { "@relative": "/product/mugg" } },
          { "@type": "ListItem", name: HOSTILE, position: 2, url: { "@relative": "/product/tee" } },
        ],
      },
    });
    relatives(page.jsonLd);
  });

  it("a tag: two tags of one address are one page", async () => {
    const page = await seoPage("/tagg/nyhet");
    expect(page.title).toBe(`Nyhet | Kläder & "Co"`);
    expect(page.bodyHtml).toContain(`<a href="/product/mugg">Mugg</a>`);
    expect(page.bodyHtml).toContain(`<a href="/product/tee">`);
    expect(page.bodyHtml).not.toContain("utkast");
  });

  it("a manual collection in its own order, without what is not public; its cover", async () => {
    const page = await seoPage("/samling/nytt");
    expect(page.title).toBe(`Nytt | Kläder & "Co"`);
    expect(page.description).toBe("Det nya");
    expect(page.bodyHtml).toBe(
      `<h1>Nytt</h1><p>Det nya</p><ul><li><a href="/product/tee">${escapeHtml(HOSTILE)}</a></li>` +
        `<li><a href="/product/mugg">Mugg</a></li></ul>`,
    );
    // The cover's object was removed in an earlier case: no image, no error.
    expect(page.image).toBeNull();
  });

  it("a smart collection follows its tag by address", async () => {
    const page = await seoPage("/samling/smart");
    expect(page.bodyHtml).toContain(`<a href="/product/mugg">Mugg</a>`);
    expect(page.bodyHtml).toContain(`<a href="/product/tee">`);
  });

  it("a content page: its meta title, the text of its HTML and nothing that runs", async () => {
    const page = await seoPage("/om-oss");
    expect(page.title).toBe("Om oss – Kläder");
    expect(page.description).toBe("Allt om oss");
    expect(page.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "WebPage",
      description: "Allt om oss",
      name: "Om oss",
      url: { "@relative": "/om-oss" },
    });
    expect(page.bodyHtml).toBe("<article><h1>Om oss</h1><p>Vi</p><p>Hej du &amp; jag</p></article>");
  });

  it("a post: date, author, BlogPosting", async () => {
    const page = await seoPage("/forsta-inlagget");
    expect(page.description).toBe("Kort om det");
    expect(page.jsonLd).toMatchObject({
      "@type": "BlogPosting",
      author: { "@type": "Person", name: "Kim" },
      datePublished: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      headline: "Första inlägget",
      url: { "@relative": "/forsta-inlagget" },
    });
    expect(page.bodyHtml).toMatch(
      /^<article><h1>Första inlägget<\/h1><p><time datetime="[^"]+">\d{4}-\d{2}-\d{2}<\/time> · Kim<\/p><p>Första inlägget.<\/p><\/article>$/,
    );
  });

  it("a legal page once the shop has adopted it; the platform terms once a version is out", async () => {
    await adoptLegalPages(shop.tenantId, {
      angerratt: "<p>Ångerrätt 14 dagar</p>",
      integritetspolicy: "<p>Personuppgifter</p>",
      kopvillkor: "<h2>Köpvillkor</h2><p>Villkor &amp; text</p>",
    });
    const terms = await seoPage("/legal/kopvillkor");
    expect(terms.title).toBe(`Köpvillkor | Kläder & "Co"`);
    expect(terms.canonicalPath).toBe("/legal/kopvillkor");
    expect(terms.bodyHtml).toBe("<article><h1>Köpvillkor</h1><p>Köpvillkor</p><p>Villkor &amp; text</p></article>");
    expect((await seoPage("/legal/angerratt-och-returer")).title).toMatch(/^Ångerrätt & returer \|/);

    // 0031 publishes the first version of the platform terms (2026-09-07).
    expect((await seoPage("/legal/plattformsvillkor")).bodyHtml).toBe("<article><h1>Plattformsvillkor</h1></article>");
    // Before any version is out, there is no such page.
    const before = Date.parse("2026-01-01T00:00:00.000Z");
    await expect(
      resolveSeoAnswer(env, env.DB, shop.context, "/legal/plattformsvillkor", before),
    ).resolves.toBeNull();
    expect((await legalPageTexts(env.DB, shop.tenantId, before)).platformTermsAt).toBeNull();
    // A version published later is not out until its date.
    await publishPlatformTerms("2099-01-01", "2099-01-01T00:00:00.000Z");
    expect((await legalPageTexts(env.DB, shop.tenantId, Date.now())).platformTermsAt).toBe("2026-09-07T00:00:00.000Z");
  });

  it("all products, in the shop's order", async () => {
    const page = await seoPage("/produkter");
    expect(page.title).toBe(`Alla produkter | Kläder & "Co"`);
    expect(page.bodyHtml).toBe(
      `<h1>Alla produkter</h1><ul><li><a href="/product/mugg">Mugg</a></li>` +
        `<li><a href="/product/tee">${escapeHtml(HOSTILE)}</a></li></ul>`,
    );
  });

  it("a forward wins over a page at the same path", async () => {
    await env.DB.prepare(
      `INSERT INTO redirects (tenant_id, from_path, to_path, created_at, created_by)
       VALUES (?, '/om-oss', '/samling/nytt', '2026-09-28T00:00:00.000Z', 'test')`,
    )
      .bind(shop.tenantId)
      .run();
    const response = await seoRequest(shop.origin, "?path=%2Fom-oss%2F");
    await expect(response.json()).resolves.toEqual({ redirect: { status: 301, to: "/samling/nytt" } });
    await env.DB.prepare("DELETE FROM redirects WHERE tenant_id = ?").bind(shop.tenantId).run();
  });

  it("keeps the body under its bound however long the page", async () => {
    await seedPage(shop.tenantId, {
      // Text that escapes to five times its length: the budget still holds.
      content: `<p>${"&".repeat(5_000)}</p>`.repeat(40),
      slug: "lang-sida",
      title: "Lång",
    });
    const page = await seoPage("/lang-sida");
    expect(page.bodyHtml.length).toBeLessThanOrEqual(BODY_HTML_MAX);
    expect(page.bodyHtml.endsWith("</article>")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the text helpers", () => {
  it("htmlToText keeps the text, drops what runs, decodes entities, and never returns markup", () => {
    expect(
      htmlToText(
        `<p>Ett &lt;b&gt; &#65;&#x42; &nbsp;&hellip;</p><script>x()</script><style>a{}</style>` +
          `<template><p>mall</p></template><!-- dold --><div>Två<br>rader</div><img src=x onerror=alert(1)>Tre`,
        1_000,
      ),
    ).toEqual(["Ett <b> AB …", "Två rader", "Tre"]);
    expect(htmlToText("<p>open <b", 100)).toEqual(["open"]);
    expect(htmlToText("<script>never closed", 100)).toEqual([]);
    expect(htmlToText("&#0;&#xD800;&#1114112;x", 100)).toEqual(["x"]);
  });

  it("htmlToText is linear: a flood of unclosed script tags is read at once", () => {
    const started = Date.now();
    expect(htmlToText("<script".repeat(50_000) + "<p>x</p>", 100)).toEqual([]);
    expect(htmlToText("<".repeat(200_000), 100)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("htmlToText cuts at its budget with an ellipsis", () => {
    const [first] = htmlToText(`<p>${"a".repeat(50)}</p>`, 10);
    expect(first).toBe(`${"a".repeat(9)}…`);
  });

  it("truncateDescription: one line, at most 160", () => {
    expect(truncateDescription("  a\n\n b  ")).toBe("a b");
    expect(truncateDescription("x".repeat(200))).toBe(`${"x".repeat(157)}...`);
    expect(truncateDescription("   ")).toBeNull();
  });

  it("parseStorefrontRoute reads the address grammar", () => {
    expect(parseStorefrontRoute("/")).toEqual({ kind: "home" });
    expect(parseStorefrontRoute("/produkter")).toEqual({ kind: "all_products" });
    expect(parseStorefrontRoute("/product/x")).toEqual({ handle: "x", kind: "product" });
    expect(parseStorefrontRoute("/samling/x")).toEqual({ handle: "x", kind: "collection" });
    expect(parseStorefrontRoute("/kategori/x")).toEqual({ kind: "category", slug: "x" });
    expect(parseStorefrontRoute("/tagg/x")).toEqual({ kind: "tag", slug: "x" });
    expect(parseStorefrontRoute("/legal/integritetspolicy")).toEqual({ key: "integritetspolicy", kind: "legal" });
    expect(parseStorefrontRoute("/om-oss")).toEqual({ kind: "page", slug: "om-oss" });
    for (const path of ["/cart", "/produkter/x", "/legal/okand", "/legal", "/a/b", "/a/b/c", "/product"]) {
      expect(parseStorefrontRoute(path), path).toBeNull();
    }
  });
});
