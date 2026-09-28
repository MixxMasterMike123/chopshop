import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HtmlRefusal } from "../src/content/html-refusal";
import { checkHtml, HTML_MAX_LENGTH } from "../src/content/html-refusal";
import { PAGE_BODY_MAX_BYTES, RESERVED_PAGE_SLUGS } from "../src/content/pages";
import type { ObjectBucket, ObjectKind } from "../src/storage/object-store";
import {
  activateObject,
  deletePendingOrMutableObject,
  reservePendingObject,
} from "../src/storage/object-store";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { ADMIN, call, type CallOptions, createTenant } from "./slice-harness";
import {
  auditCount,
  auditRows,
  expectJson,
  expectOpaque404,
  platform,
  SliceWorld,
  type Tenant,
  tenantRow,
  tenantWorld,
} from "./tenant-fixtures";

/**
 * CP4-C — content pages and posts (migrations/0042 `pages`), part 1: the HTML
 * refusal at write (src/content/html-refusal.ts), the 0042 schema, and the
 * admin routes (/v1/admin/pages). The public reads are in public-pages.test.ts,
 * the legal pages in public-legal.test.ts.
 */

const NOW = 1_790_000_000_000;
const PUBLIC_BASE = "https://public-objects.test.invalid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ═══════════════════════════════════════════════════════════════════════════
// The refusal (pure)
// ═══════════════════════════════════════════════════════════════════════════

/** What an editor writes, and a little more; each must be admitted as it is. */
const ACCEPTED: readonly string[] = [
  "",
  "Ren text utan märkning — 100 % säker, och 3 > 2.",
  "<h1>Om oss</h1><p>Vi säljer <strong>tröjor</strong> &amp; <em>mössor</em>.</p>",
  '<p class="ql-align-center"><span style="color: rgb(230, 0, 0); background-color: rgb(255, 255, 0);">Röd</span></p>',
  '<ol><li data-list="ordered">Ett</li><li data-list="bullet">Två</li></ol><ul><li>Tre</li></ul>',
  '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Länk</a></p>',
  '<p><a href="mailto:hej@example.com">Mejla</a> eller <a href="tel:+46701234567">ring</a></p>',
  '<p><a href="/produkter">Alla</a> <a href="#faq">FAQ</a> <a href="//cdn.example.com/x">x</a> <a href="?q=a:b">q</a></p>',
  `<p><img src="${PUBLIC_BASE}/shops/t/product_media/id/v1/a.png" alt="Bild" width="640" height="480"></p>`,
  '<picture><source srcset="https://x.example/a.webp 1x, https://x.example/a2.webp 2x"><img src="https://x.example/a.png"></picture>',
  "<br><br/><br /><hr>",
  "<!-- en kommentar --><p>Text</p>",
  "<blockquote>Citat</blockquote><pre><code>kod</code></pre><s>struken</s><u>under</u>",
  "<table><tr><td colspan=2 nowrap>Cell</td><td rowspan = '3'>Två</td></tr></table>",
  '<P CLASS="x">Versaler</P >',
  '<p title="a &gt; b &quot;c&quot; &#229; &#xE5; &nbsp; &apos;d&apos; &lt;e&gt; & f">Referenser</p>',
  "<p>Text med &hellip; &aring; &mdash; &#8212; och en lös & här</p>",
  '<p style="width: calc(100% - 2rem); color: hsl(0 0% 0% / 50%); font-family: &quot;Open Sans&quot;">x</p>',
  '<video src="https://x.example/v.mp4" poster="https://x.example/p.jpg" controls></video>',
  '<p\n  class="x"\n  title=\'y\'\n>Radbrytningar i taggen</p>',
  "<my-widget data-x=1>Eget element</my-widget>",
  '<p lang="sv" dir="ltr" id="a" aria-label="b">Attribut</p>',
];

const REFUSED: ReadonlyArray<readonly [string, string, HtmlRefusal]> = [
  // script
  ["a script element", "<script>alert(1)</script>", "script"],
  ["upper-case", "<SCRIPT>alert(1)</SCRIPT>", "script"],
  ["white space in the tag", "<script\n>alert(1)</script\t>", "script"],
  ["a slash after the name", '<script/src="https://x/a.js"></script>', "script"],
  ["a lone end tag", "<p>ok</p></script>", "script"],
  ["inside a comment", "<!-- <script>alert(1)</script> -->", "script"],
  ["behind --!>", "<!-- --!><script>alert(1)</script> -->", "script"],
  ["behind <!-->", "<!--><script>alert(1)</script>-->", "script"],
  // embedded content
  ["an iframe", '<iframe src="https://x.example"></iframe>', "embedded_content"],
  ["an object", '<object data="https://x.example/a"></object>', "embedded_content"],
  ["an embed", '<embed src="https://x.example/a">', "embedded_content"],
  ["an upper-case iframe", "<IFRAME SRCDOC=x></IFRAME>", "embedded_content"],
  ["srcdoc anywhere", '<p srcdoc="&lt;b&gt;x&lt;/b&gt;">x</p>', "embedded_content"],
  ["a frameset", "<frameset></frameset>", "embedded_content"],
  ["an applet", "<applet></applet>", "embedded_content"],
  // event attributes
  ["onerror", '<img src="x.png" onerror="alert(1)">', "event_attribute"],
  ["upper-case, unquoted", "<img src=x.png ONERROR=alert(1)>", "event_attribute"],
  ["after a tab", '<a href="x"\tonclick="y">x</a>', "event_attribute"],
  ["ontoggle", '<details open ontoggle="y">x</details>', "event_attribute"],
  ["onmouseover on a span", "<span onmouseover=x>x</span>", "event_attribute"],
  // javascript: and friends
  ["javascript:", '<a href="javascript:alert(1)">x</a>', "javascript_url"],
  ["mixed case", '<a href="JaVaScRiPt:alert(1)">x</a>', "javascript_url"],
  ["a tab inside the scheme", '<a href=" java\tscript:alert(1)">x</a>', "javascript_url"],
  ["a space inside the scheme", '<a href="java script:alert(1)">x</a>', "javascript_url"],
  ["a decimal reference", '<a href="&#106;avascript:alert(1)">x</a>', "javascript_url"],
  ["hex references", '<a href="&#x6A;avascript&#x3A;alert(1)">x</a>', "javascript_url"],
  ["a referenced tab", '<a href="jav&#x09;ascript:alert(1)">x</a>', "javascript_url"],
  ["vbscript:", '<a href="vbscript:msgbox(1)">x</a>', "javascript_url"],
  ["in a title", '<p title="javascript:x">x</p>', "javascript_url"],
  ["in text", "<p>javascript:void(0)</p>", "javascript_url"],
  // references HTML knows and the scan does not
  ["&NewLine;", '<a href="java&NewLine;script:alert(1)">x</a>', "entity_reference"],
  ["&colon;", '<a href="javascript&colon;alert(1)">x</a>', "entity_reference"],
  ["&Tab;", '<a href="java&Tab;script:alert(1)">x</a>', "entity_reference"],
  ["a reference without its semicolon", '<a href="&#106avascript:alert(1)">x</a>', "entity_reference"],
  ["&amp without its semicolon", '<a href="?a=1&amp b">x</a>', "entity_reference"],
  ["a reference to NUL", '<p title="&#0;">x</p>', "entity_reference"],
  ["a reference to a C1 control", '<p title="&#x80;">x</p>', "entity_reference"],
  ["a reference to a surrogate", '<p title="&#xD800;">x</p>', "entity_reference"],
  ["a reference past Unicode", '<p title="&#x110000;">x</p>', "entity_reference"],
  // addresses
  ["data: in a link", '<a href="data:text/html;base64,PHA+">x</a>', "unsafe_address"],
  ["data: in an image", '<img src="data:image/png;base64,iVBORw0KGgo=">', "unsafe_address"],
  ["data: in a srcset", '<img srcset="https://x/a.png 1x, data:image/png;base64,AA 2x">', "unsafe_address"],
  ["data: behind a reference", '<a href="&#100;ata:text/html,x">x</a>', "unsafe_address"],
  ["ftp:", '<a href="ftp://x.example/a">x</a>', "unsafe_address"],
  ["blob:", '<a href="blob:https://x.example/id">x</a>', "unsafe_address"],
  ["a scheme-like first segment", '<a href="x:y">x</a>', "unsafe_address"],
  ["a colon with no valid scheme", '<a href="1x:y">x</a>', "unsafe_address"],
  ["a poster", '<video poster="data:image/png,x"></video>', "unsafe_address"],
  ["a background", '<table background="data:image/png,x"></table>', "unsafe_address"],
  ["a ping list", '<a href="/x" ping="https://a.example data:x">x</a>', "unsafe_address"],
  // style
  ["url(", '<p style="background:url(https://x.example/a.png)">x</p>', "unsafe_style"],
  ["url (", '<p style="background: url (x)">x</p>', "unsafe_style"],
  ["expression(", '<p style="width:expression(alert(1))">x</p>', "unsafe_style"],
  ["behavior", '<p style="behavior:url(x.htc)">x</p>', "unsafe_style"],
  ["image-set(", "<p style=\"background-image:image-set('x.png' 1x)\">x</p>", "unsafe_style"],
  ["@import", "<p style=\"@import 'x.css'\">x</p>", "unsafe_style"],
  ["a bare (", '<p style="width:(1px)">x</p>', "unsafe_style"],
  ["a CSS escape", '<p style="background:\\75 rl(x)">x</p>', "escape"],
  ["url( behind a reference", '<p style="background:u&#114;l(x)">x</p>', "unsafe_style"],
  ["url( behind a comment", '<p style="background:url/**/(x)">x</p>', "unsafe_style"],
  // raw text and RCDATA elements
  ["a style element", "<style>p{color:red}</style>", "raw_text_element"],
  ["a style element with @import", "<style>@import 'x';</style>", "raw_text_element"],
  [
    "noscript around a value",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    "raw_text_element",
  ],
  ["textarea", "<textarea></textarea>", "raw_text_element"],
  ["title", "<title>x</title>", "raw_text_element"],
  ["xmp", "<xmp>x</xmp>", "raw_text_element"],
  ["template", "<template><p>x</p></template>", "raw_text_element"],
  ["noembed", "<noembed>x</noembed>", "raw_text_element"],
  ["plaintext", "<plaintext>x", "raw_text_element"],
  // foreign content and namespaces
  ["svg", "<svg onload=alert(1)>", "foreign_content"],
  ["svg with a script", "<svg><script>alert(1)</script></svg>", "foreign_content"],
  ["MathML", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>", "foreign_content"],
  ["foreignObject", "<foreignObject></foreignObject>", "foreign_content"],
  ["a namespaced element", "<svg:script>alert(1)</svg:script>", "foreign_content"],
  ["another namespace", "<x:p>x</x:p>", "foreign_content"],
  ["a namespaced end tag", "<p>x</svg:p>", "foreign_content"],
  ["a namespaced attribute", '<a xlink:href="#x">x</a>', "foreign_content"],
  // forms
  ["a form", '<form action="https://x.example"></form>', "form"],
  ["an input", "<input type=text>", "form"],
  ["a button", "<button>x</button>", "form"],
  ["formaction anywhere", '<p formaction="https://x.example">x</p>', "form"],
  ["action anywhere", '<p action="https://x.example">x</p>', "form"],
  ["isindex", "<isindex>", "form"],
  // the document around the page
  ["base", '<base href="https://x.example/">', "document_element"],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://x.example">', "document_element"],
  ["link", '<link rel="stylesheet" href="https://x.example/a.css">', "document_element"],
  ["body", '<body class="x">', "document_element"],
  ["html", "<html>", "document_element"],
  // declarations and processing instructions
  ["a DOCTYPE", "<!DOCTYPE html><p>x</p>", "declaration"],
  ["CDATA", "<![CDATA[<script>alert(1)</script>]]>", "declaration"],
  ["a bogus comment", "<!ELEMENT x>", "declaration"],
  ["a Word conditional comment", "<!--[if gte mso 9]><p>x</p><![endif]-->", "declaration"],
  ["an XML declaration", '<?xml version="1.0"?><p>x</p>', "processing_instruction"],
  ["a PHP tag", "<?php echo 1 ?>", "processing_instruction"],
  // what the scan cannot read with certainty
  ["a raw <", "<p>1 < 2</p>", "malformed"],
  ["< then a space", "< script>alert(1)</script>", "malformed"],
  ["a tag inside a tag name", "<scr<script>ipt>alert(1)</script>", "malformed"],
  ["a slash before an attribute", "<img/onerror=alert(1)>", "malformed"],
  ["a slash between attributes", '<a href="x"/onclick="y">x</a>', "malformed"],
  ["no space after a value", '<a href="x"onclick="y">x</a>', "malformed"],
  ["< inside a value", '<p title="</p><script>alert(1)</script>">x</p>', "malformed"],
  ["< inside a single-quoted value", "<p title='a<b'>x</p>", "malformed"],
  ["a quote as an attribute name", '<img """><script>alert(1)</script>">', "malformed"],
  ["a quote in an unquoted value", '<a href=x"y>x</a>', "malformed"],
  ["a backtick in an unquoted value", "<a href=`x`>x</a>", "malformed"],
  ["= in an unquoted value", "<a href=a=b>x</a>", "malformed"],
  ["a duplicate attribute", '<p class="a" class="b">x</p>', "malformed"],
  ["an unterminated value", '<p title="x>y', "malformed"],
  ["an unterminated comment", "<p>x</p><!-- nothing after", "malformed"],
  ["an end tag with an attribute", "<p>x</p foo>", "malformed"],
  ["an empty end tag", "<p>x</>", "malformed"],
  ["= before a name", "<p =x>y</p>", "malformed"],
  ["an empty value", "<p a=>y</p>", "malformed"],
  ["a non-ASCII letter in a name", "<ſcript>alert(1)</ſcript>", "malformed"],
  ["a no-break space in a tag", '<p onclick="x">y</p>', "malformed"],
  ["a tag cut off at the end", "<p", "malformed"],
  ["an attribute cut off at the end", "<p class", "malformed"],
  // characters
  ["NUL", "<p>\u0000</p>", "invalid_character"],
  ["a form feed", '<a href="x"\u000conclick=y>x</a>', "invalid_character"],
  ["DEL", "<p>\u007f</p>", "invalid_character"],
  ["a lone surrogate", "<p>\ud800</p>", "invalid_character"],
  // the source system's storage
  ["a Firebase Storage image", '<img src="https://firebasestorage.googleapis.com/v0/b/x/o/y.png">', "storage_address"],
  ["a Cloud Storage link", '<a href="https://storage.googleapis.com/bucket/x">x</a>', "storage_address"],
  ["a percent-encoded dot", '<img src="https://firebasestorage%2Egoogleapis.com/x">', "storage_address"],
  ["a bucket host in text", "<p>Se https://project.appspot.com/x</p>", "storage_address"],
  ["a new-style bucket", '<img src="https://p.firebasestorage.app/x.png">', "storage_address"],
  ["upper-case", '<img src="HTTPS://FIREBASESTORAGE.GOOGLEAPIS.COM/x">', "storage_address"],
];

describe("html-refusal: what an editor writes is admitted as it is", () => {
  it.each(ACCEPTED.map((html) => [html.slice(0, 60), html]))("admits %j", (_label, html) => {
    expect(checkHtml(html)).toEqual({ ok: true });
  });

  it("admits a text of exactly the maximum length and refuses one character more", () => {
    const at = `<p>${"a".repeat(HTML_MAX_LENGTH - 7)}</p>`;
    expect(at.length).toBe(HTML_MAX_LENGTH);
    expect(checkHtml(at)).toEqual({ ok: true });
    expect(checkHtml(`${at} `)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("html-refusal: refuse, never repair", () => {
  it.each(REFUSED)("refuses %s", (_label, html, reason) => {
    expect(checkHtml(html)).toEqual({ ok: false, reason });
  });

  // Every `<` is visited: a tag inserted ANYWHERE in admitted content — in
  // text, in a comment, inside a tag, inside a value, inside a reference —
  // is either read as that tag and refused, or makes the content malformed.
  it.each([
    ["<script>alert(1)</script>"],
    ["<img src=x onerror=alert(1)>"],
    ["<iframe srcdoc=x>"],
    ["<svg onload=alert(1)>"],
  ])("refuses %s inserted at every position of every admitted sample", (payload) => {
    let checked = 0;
    for (const sample of ACCEPTED) {
      for (let index = 0; index <= sample.length; index += 1) {
        const verdict = checkHtml(sample.slice(0, index) + payload + sample.slice(index));
        expect(verdict.ok, `${JSON.stringify(sample)} at ${index}`).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures for the schema and the routes
// ═══════════════════════════════════════════════════════════════════════════

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;

function context(tenant: Tenant): TenantContext {
  return { domainKind: "admin", hostname: "", tenantId: tenant.tenantId };
}

/** A stored object made the way the upload makes it: reserved, then activated. */
async function objectRow(
  tenant: Tenant,
  options: { activate?: boolean; bucket?: ObjectBucket; kind?: ObjectKind } = {},
): Promise<string> {
  const reserved = await reservePendingObject(
    env.DB,
    context(tenant),
    {
      bucket: options.bucket ?? "public",
      contentType: "image/png",
      fileName: "photo.png",
      kind: options.kind ?? "product_media",
    },
    NOW,
  );
  if (reserved.status !== "ok") {
    throw new Error(`reserve failed: ${reserved.status}`);
  }
  if (options.activate !== false) {
    const activated = await activateObject(
      env.DB,
      context(tenant),
      reserved.object.objectId,
      { dimensions: { height: 480, width: 640 }, sha256: "c".repeat(64), sizeBytes: 2_048 },
      NOW,
    );
    expect(activated.status).toBe("ok");
  }
  return reserved.object.objectId;
}

async function catalogVersion(tenant: Tenant): Promise<number> {
  return (await tenantRow(tenant.tenantId))?.catalog_version ?? -1;
}

function adminAs(tenant: Tenant, method: string, path: string, body?: unknown, options: CallOptions = {}) {
  return call(world, method, `${ADMIN}${path}`, {
    body,
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

interface PageBody {
  page: {
    author: string | null;
    content: Record<string, string>;
    createdAt: string;
    createdBy: string | null;
    image: { contentType: string; height: number | null; objectId: string; url: string; width: number | null } | null;
    imageObjectId: string | null;
    kind: string;
    metaDescription: Record<string, string> | null;
    metaTitle: Record<string, string> | null;
    pageId: string;
    path: string;
    publishedAt: string | null;
    slug: string;
    status: string;
    summary: Record<string, string> | null;
    title: Record<string, string>;
    updatedAt: string;
    updatedBy: string | null;
  };
}

function draft(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { content: { "sv-SE": `<p>Innehåll ${slug}</p>` }, slug, title: { "sv-SE": `Rubrik ${slug}` }, ...extra };
}

async function createPage(tenant: Tenant, body: Record<string, unknown>): Promise<PageBody["page"]> {
  return (await expectJson<PageBody>(await adminAs(tenant, "POST", "/v1/admin/pages", body), 201, `create ${String(body.slug)}`))
    .page;
}

async function pageRow(pageId: string) {
  return env.DB.prepare("SELECT * FROM pages WHERE page_id = ?").bind(pageId).first<Record<string, unknown>>();
}

beforeAll(async () => {
  const setup = await tenantWorld("pg", 2);
  world = setup.world;
  [shopA, shopB] = setup.tenants as [Tenant, Tenant];
}, 120_000);

beforeEach(() => {
  world.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// The 0042 schema
// ═══════════════════════════════════════════════════════════════════════════

describe("the 0042 schema", () => {
  const iso = "2026-09-28T00:00:00.000Z";
  let seq = 0;

  function insertPage(overrides: Record<string, unknown> = {}): Promise<D1Result> {
    seq += 1;
    const row: Record<string, unknown> = {
      content_json: '{"sv-SE":"<p>x</p>"}',
      created_at: iso,
      page_id: `schema-${seq}`,
      slug: `schema-${seq}`,
      tenant_id: shopA.tenantId,
      title_json: '{"sv-SE":"Rubrik"}',
      updated_at: iso,
      ...overrides,
    };
    const columns = Object.keys(row);
    return env.DB.prepare(
      `INSERT INTO pages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
      .bind(...Object.values(row))
      .run();
  }

  it("admits a well-formed row, a post with every optional field, and an imported id", async () => {
    await expect(insertPage()).resolves.toBeDefined();
    await expect(
      insertPage({
        author: "Kent",
        kind: "post",
        meta_description_json: '{"sv-SE":"Beskrivning"}',
        meta_title_json: '{"en-US":"Title","sv-SE":"Titel"}',
        page_id: "Ab3dE5gH9jK1mN2pQ4rS",
        published_at: iso,
        status: "published",
        summary_json: "{}",
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["an upper-case slug", { slug: "Om-oss" }],
    ["a leading hyphen", { slug: "-om" }],
    ["a trailing hyphen", { slug: "om-" }],
    ["a slash", { slug: "legal/kopvillkor" }],
    ["a space", { slug: "om oss" }],
    ["a slug over 100 characters", { slug: "a".repeat(101) }],
    ["an unknown kind", { kind: "article" }],
    ["an unknown status", { status: "archived" }],
    ["a title that is not an object", { title_json: '["x"]' }],
    ["an empty title", { title_json: "{}" }],
    ["an empty content", { content_json: "{}" }],
    ["a title value that is not a string", { title_json: '{"sv-SE":1}' }],
    ["a nested content value", { content_json: '{"sv-SE":{"html":"x"}}' }],
    ["a language key that is not a tag", { title_json: '{"swedish":"x"}' }],
    ["a lower-case region", { title_json: '{"sv-se":"x"}' }],
    ["a summary value that is not a string", { summary_json: '{"sv-SE":null}' }],
    ["content over 262 144 bytes (counted as bytes)", { content_json: JSON.stringify({ "sv-SE": "å".repeat(131_070) }) }],
    ["a published page without a date", { status: "published" }],
    ["a date that is not ISO", { published_at: "2026-09-28 00:00:00" }],
    ["updated before created", { updated_at: "2026-09-27T00:00:00.000Z" }],
    ["an empty author", { author: "" }],
    ["an id with a slash", { page_id: "a/b" }],
    ["an image that does not exist", { image_object_id: "no-such-object" }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(insertPage(overrides)).rejects.toThrow();
  });

  it("refuses every reserved slug, on insert and on update, and the list equals the code's", async () => {
    for (const slug of RESERVED_PAGE_SLUGS.filter((value) => /^[a-z0-9-]+$/.test(value))) {
      await expect(insertPage({ slug })).rejects.toThrow(/reserved by the storefront/);
    }
    await insertPage({ page_id: "schema-rename", slug: "schema-rename" });
    await expect(
      env.DB.prepare("UPDATE pages SET slug = 'checkout' WHERE page_id = 'schema-rename'").run(),
    ).rejects.toThrow(/reserved by the storefront/);

    for (const name of ["pages_reserved_slug_insert", "pages_reserved_slug_update"]) {
      const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .bind(name)
        .first<{ sql: string }>();
      const list = /IN \(([^)]*)\)/.exec(trigger?.sql ?? "")?.[1] ?? "";
      const slugs = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(slugs.sort(), name).toEqual([...RESERVED_PAGE_SLUGS].sort());
    }
  });

  it("keeps tenant_id and page_id immutable", async () => {
    await insertPage({ page_id: "schema-immutable", slug: "schema-immutable" });
    await expect(
      env.DB.prepare("UPDATE pages SET tenant_id = ? WHERE page_id = 'schema-immutable'").bind(shopB.tenantId).run(),
    ).rejects.toThrow(/tenant_id is immutable/);
    await expect(
      env.DB.prepare("UPDATE pages SET page_id = 'other' WHERE page_id = 'schema-immutable'").run(),
    ).rejects.toThrow(/page_id is immutable/);
  });

  it("names only a public product image of the page's own tenant", async () => {
    const own = await objectRow(shopA);
    const foreign = await objectRow(shopB);
    const branding = await objectRow(shopA, { kind: "shop_branding" });
    const privateDocument = await objectRow(shopA, { bucket: "private", kind: "document" });

    await expect(insertPage({ image_object_id: own })).resolves.toBeDefined();
    for (const [label, objectId] of [
      ["another tenant's", foreign],
      ["a branding", branding],
      ["a private", privateDocument],
    ] as const) {
      await expect(insertPage({ image_object_id: objectId }), label).rejects.toThrow(/public product image/);
    }
    await insertPage({ page_id: "schema-image", slug: "schema-image" });
    await expect(
      env.DB.prepare("UPDATE pages SET image_object_id = ? WHERE page_id = 'schema-image'").bind(foreign).run(),
    ).rejects.toThrow(/public product image/);
  });

  it("bumps catalog_version on every insert, update and delete of a page", async () => {
    let version = await catalogVersion(shopA);
    await insertPage({ page_id: "schema-bump", slug: "schema-bump" });
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);

    version = await catalogVersion(shopA);
    await env.DB.prepare("UPDATE pages SET author = 'x' WHERE page_id = 'schema-bump'").run();
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);

    version = await catalogVersion(shopA);
    await env.DB.prepare("DELETE FROM pages WHERE page_id = 'schema-bump'").run();
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);
  });

  // 0042 bumps for an object a PAGE names; builders A (0040) and D (0043)
  // add wider triggers on public objects, so an unrelated object may bump too.
  it("bumps on a legal-pages adoption, and on a change of an object a page names", async () => {
    let version = await catalogVersion(shopA);
    await expectJson(
      await adminAs(shopA, "POST", "/v1/admin/legal/accept-pages", {
        custom: false,
        pod: false,
        templateVersion: "2026-09-07",
        texts: { angerratt: "<p>Å</p>", integritetspolicy: "<p>I</p>", kopvillkor: "<p>K</p>" },
      }),
      201,
      "adopt",
    );
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);

    const named = await objectRow(shopA);
    const unnamed = await objectRow(shopA);
    await insertPage({ image_object_id: named, page_id: "schema-named", slug: "schema-named" });

    // The type is part of the image's public shape, and no wider trigger
    // watches it: 0042's alone decides here.
    version = await catalogVersion(shopA);
    const retype = "UPDATE stored_objects SET content_type = 'image/webp' WHERE object_id = ?";
    await env.DB.prepare(retype).bind(unnamed).run();
    expect(await catalogVersion(shopA)).toBe(version);
    await env.DB.prepare(retype).bind(named).run();
    expect(await catalogVersion(shopA)).toBe(version + 1);

    version = await catalogVersion(shopA);
    expect((await deletePendingOrMutableObject(env.DB, context(shopA), named, NOW)).status).toBe("ok");
    expect(await catalogVersion(shopA)).toBeGreaterThan(version);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The admin routes: the refusals first
// ═══════════════════════════════════════════════════════════════════════════

describe("who may read and write pages", () => {
  let pageA: PageBody["page"];

  beforeAll(async () => {
    pageA = await createPage(shopA, draft("vem-far"));
  });

  it("anonymous callers get the opaque 404 on every route and method", async () => {
    const before = await auditCount();
    const anonymous = { cookie: undefined, shopId: shopA.tenantId };
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/pages", undefined, anonymous), "list");
    await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/pages", draft("anon"), anonymous), "create");
    await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/pages/${pageA.pageId}`, undefined, anonymous), "read");
    await expectOpaque404(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${pageA.pageId}`, { author: "x" }, anonymous),
      "patch",
    );
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/pages/${pageA.pageId}`, undefined, anonymous), "delete");
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/pages", undefined, { shopId: undefined }), "no X-Shop-Id");
    expect(await auditCount()).toBe(before);
    expect(await pageRow(pageA.pageId)).toMatchObject({ author: null });
  });

  it("another shop's admin can neither see nor touch this shop's pages", async () => {
    const asB = { cookie: shopB.adminCookie, shopId: shopA.tenantId };
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/pages", undefined, asB), "B lists A");
    await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/pages", draft("kapad"), asB), "B creates in A");
    await expectOpaque404(await adminAs(shopA, "PATCH", `/v1/admin/pages/${pageA.pageId}`, { author: "B" }, asB), "B edits A");
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/pages/${pageA.pageId}`, undefined, asB), "B deletes A");

    // B's own shop: A's page id does not exist there.
    for (const method of ["GET", "PATCH", "DELETE"]) {
      await expectOpaque404(
        await adminAs(shopB, method, `/v1/admin/pages/${pageA.pageId}`, method === "PATCH" ? { author: "B" } : undefined),
        `B ${method} A's id in B`,
      );
    }
    const listB = await expectJson<{ pages: unknown[] }>(await adminAs(shopB, "GET", "/v1/admin/pages"), 200, "B's list");
    expect(JSON.stringify(listB)).not.toContain(pageA.pageId);
    expect(await pageRow(pageA.pageId)).toMatchObject({ author: null, tenant_id: shopA.tenantId });
  });

  it("cross-origin and origin-less writes are refused before the body is read", async () => {
    const before = await auditCount();
    for (const origin of ["https://evil.test", null]) {
      await expectOpaque404(await adminAs(shopA, "POST", "/v1/admin/pages", draft("csrf"), { origin }), `POST ${origin}`);
      await expectOpaque404(
        await adminAs(shopA, "PATCH", `/v1/admin/pages/${pageA.pageId}`, { author: "csrf" }, { origin }),
        `PATCH ${origin}`,
      );
      await expectOpaque404(
        await adminAs(shopA, "DELETE", `/v1/admin/pages/${pageA.pageId}`, undefined, { origin }),
        `DELETE ${origin}`,
      );
    }
    expect(await auditCount()).toBe(before);
    expect(await pageRow(pageA.pageId)).not.toBeNull();
  });

  it("methods the routes do not claim fall through to the 404", async () => {
    await expectOpaque404(await adminAs(shopA, "PUT", "/v1/admin/pages", draft("put")), "PUT list");
    await expectOpaque404(await adminAs(shopA, "DELETE", "/v1/admin/pages"), "DELETE list");
    await expectOpaque404(await adminAs(shopA, "POST", `/v1/admin/pages/${pageA.pageId}`, draft("post-id")), "POST id");
    await expectOpaque404(await adminAs(shopA, "PUT", `/v1/admin/pages/${pageA.pageId}`, draft("put-id")), "PUT id");
    const head = await adminAs(shopA, "HEAD", `/v1/admin/pages/${pageA.pageId}`);
    expect(head.status).toBe(404);
  });

  it("a malformed page id is the opaque 404", async () => {
    for (const segment of ["%ZZ", "a%2Fb", "a.b", "a".repeat(129), "%20"]) {
      await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/pages/${segment}`), segment);
    }
    await expectOpaque404(await adminAs(shopA, "GET", "/v1/admin/pages/no-such-page"), "unknown id");
  });

  it("a platform user needs an acting-as grant; with one it writes, audited with the grant", async () => {
    const asPlatform = { cookie: world.platformCookie, shopId: shopB.tenantId };
    await expectOpaque404(await adminAs(shopB, "GET", "/v1/admin/pages", undefined, asPlatform), "no grant");

    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "support" } }),
      201,
      "acting-as grant",
    );
    const grant = await env.DB.prepare(
      "SELECT id FROM acting_as_grants WHERE tenant_id = ? AND platform_user_id = ? AND revoked_at IS NULL",
    )
      .bind(shopB.tenantId, world.platformUserId)
      .first<{ id: string }>();

    const created = await expectJson<PageBody>(
      await adminAs(shopB, "POST", "/v1/admin/pages", draft("support"), asPlatform),
      201,
      "create as platform",
    );
    expect(created.page.createdBy).toBe(world.platformUserId);
    expect((await auditRows(shopB.tenantId, "pages.create")).at(-1)).toMatchObject({
      actorUserId: world.platformUserId,
      metadata: { actingAsGrantId: grant?.id, kind: "page", slug: "support", status: "draft" },
      resourceId: created.page.pageId,
      resourceType: "page",
    });
  });
});

describe("what a write must carry", () => {
  it.each([
    ["no body", undefined],
    ["an array", []],
    ["an empty object", {}],
    ["no title", { content: { "sv-SE": "<p>x</p>" }, slug: "utan-rubrik" }],
    ["no content", { slug: "utan-text", title: { "sv-SE": "x" } }],
    ["no slug", { content: { "sv-SE": "<p>x</p>" }, title: { "sv-SE": "x" } }],
    ["an unknown field", { ...draft("okand"), attachments: [] }],
    ["a slug with upper case", draft("Om-Oss")],
    ["a slug with a slash", draft("legal/kopvillkor")],
    ["a slug that is not a string", { ...draft("x"), slug: 7 }],
    ["a title that is a string", { ...draft("titel-strang"), title: "Rubrik" }],
    ["a blank title", { ...draft("tom-titel"), title: { "sv-SE": "   " } }],
    ["a title with a line break", { ...draft("titel-rad"), title: { "sv-SE": "a\nb" } }],
    ["a title over 300 characters", { ...draft("lang-titel"), title: { "sv-SE": "x".repeat(301) } }],
    ["a language that is not a tag", { ...draft("sprak"), title: { svenska: "x" } }],
    ["eleven languages", { ...draft("elva"), title: Object.fromEntries(Array.from({ length: 11 }, (_v, i) => [`a${String.fromCharCode(97 + i)}`, "x"])) }],
    ["content that is not a map", { ...draft("inte-karta"), content: "<p>x</p>" }],
    ["an empty content map", { ...draft("tom-karta"), content: {} }],
    ["an unknown kind", { ...draft("sort"), kind: "article" }],
    ["an unknown status", { ...draft("status"), status: "live" }],
    ["a published page with its date cleared", { ...draft("datum"), publishedAt: null, status: "published" }],
    ["a date without milliseconds", { ...draft("datum-ms"), publishedAt: "2026-09-28T00:00:00Z" }],
    ["an impossible date", { ...draft("datum-fel"), publishedAt: "2026-02-30T00:00:00.000Z" }],
    ["a blank author", { ...draft("forfattare"), author: " " }],
    ["an author with a control character", { ...draft("forfattare-2"), author: "a\u0007b" }],
    ["an object id with a slash", { ...draft("bild"), imageObjectId: "a/b" }],
    ["a summary with a lone surrogate", { ...draft("sammanfattning"), summary: { "sv-SE": "\ud800" } }],
  ])("refuses %s with 400 invalid_request", async (_label, body) => {
    const before = await auditCount();
    const response = await adminAs(shopA, "POST", "/v1/admin/pages", body);
    expect(await expectJson(response, 400, "create")).toEqual({
      error: { code: "invalid_request", message: "Request is not valid" },
    });
    expect(await auditCount()).toBe(before);
  });

  it("refuses a malformed JSON body", async () => {
    const response = await call(world, "POST", `${ADMIN}/v1/admin/pages`, {
      cookie: shopA.adminCookie,
      rawBody: '{"slug":',
      shopId: shopA.tenantId,
    });
    expect(response.status).toBe(400);
  });

  it.each([...RESERVED_PAGE_SLUGS.filter((slug) => /^[a-z0-9-]+$/.test(slug))])(
    "refuses the reserved slug %s with 400 slug_reserved",
    async (slug) => {
      const body = await expectJson(await adminAs(shopA, "POST", "/v1/admin/pages", draft(slug)), 400, slug);
      expect(body).toEqual({ error: { code: "slug_reserved", message: "The slug is reserved by the storefront" } });
    },
  );

  it("refuses refused content with its reason and language, and stores nothing", async () => {
    const before = await auditCount();
    const body = await expectJson(
      await adminAs(shopA, "POST", "/v1/admin/pages", {
        ...draft("farlig"),
        content: { "en-US": "<p>fine</p>", "sv-SE": '<p>ok</p><img src=x onerror="alert(1)">' },
      }),
      400,
      "refused",
    );
    expect(body).toEqual({
      error: {
        code: "content_refused",
        language: "sv-SE",
        message: "The content holds markup this route does not accept",
        reason: "event_attribute",
      },
    });
    expect(await env.DB.prepare("SELECT 1 FROM pages WHERE slug = 'farlig'").first()).toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it("answers 413 for a body over 1 MiB, content over 256 KiB of stored JSON, or one text over the scan's length", async () => {
    const declared = await call(world, "POST", `${ADMIN}/v1/admin/pages`, {
      cookie: shopA.adminCookie,
      headers: { "content-length": String(PAGE_BODY_MAX_BYTES + 1) },
      rawBody: JSON.stringify(draft("stor")),
      shopId: shopA.tenantId,
    });
    expect(declared.status).toBe(413);

    const streamed = await adminAs(shopA, "POST", "/v1/admin/pages", {
      ...draft("stor-2"),
      content: { "sv-SE": "x".repeat(PAGE_BODY_MAX_BYTES) },
    });
    expect(streamed.status).toBe(413);

    // 131 100 characters, 262 200 bytes: the cap is on bytes.
    const bytes = await adminAs(shopA, "POST", "/v1/admin/pages", {
      ...draft("stor-3"),
      content: { "sv-SE": "å".repeat(131_100) },
    });
    expect(await expectJson(bytes, 413, "bytes")).toEqual({
      error: { code: "payload_too_large", message: "The page exceeds the maximum allowed size" },
    });

    const scan = await adminAs(shopA, "POST", "/v1/admin/pages", {
      ...draft("stor-4"),
      content: { "sv-SE": "x".repeat(HTML_MAX_LENGTH + 1) },
    });
    expect(scan.status).toBe(413);
    expect(await env.DB.prepare("SELECT 1 FROM pages WHERE slug LIKE 'stor%'").first()).toBeNull();
  });

  it("refuses an image that is not an active public product image of this shop", async () => {
    const candidates = {
      "another shop's": await objectRow(shopB),
      "a pending": await objectRow(shopA, { activate: false }),
      "a private": await objectRow(shopA, { bucket: "private", kind: "document" }),
      "a branding": await objectRow(shopA, { kind: "shop_branding" }),
      "an unknown": "00000000-0000-4000-8000-000000000000",
    };
    const removed = await objectRow(shopA);
    await deletePendingOrMutableObject(env.DB, context(shopA), removed, NOW);

    for (const [label, objectId] of [...Object.entries(candidates), ["a removed", removed] as const]) {
      const body = await expectJson(
        await adminAs(shopA, "POST", "/v1/admin/pages", { ...draft(`bild-${label.length}`), imageObjectId: objectId }),
        400,
        label,
      );
      expect(body, label).toEqual({
        error: { code: "image_not_referencable", message: "The image is not a public product image of this shop" },
      });
    }
  });

  it("answers 409 for a slug another page of this shop has, and admits it in another shop", async () => {
    await createPage(shopA, draft("samma"));
    const body = await expectJson(await adminAs(shopA, "POST", "/v1/admin/pages", draft("samma")), 409, "taken");
    expect(body).toEqual({ error: { code: "slug_taken", message: "Another page of this shop has the slug" } });
    await createPage(shopB, draft("samma"));

    const other = await createPage(shopA, draft("annan"));
    expect(
      await expectJson(await adminAs(shopA, "PATCH", `/v1/admin/pages/${other.pageId}`, { slug: "samma" }), 409, "rename"),
    ).toEqual({ error: { code: "slug_taken", message: "Another page of this shop has the slug" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The admin routes: the happy path
// ═══════════════════════════════════════════════════════════════════════════

describe("creating, reading, editing and deleting a page", () => {
  it("creates a draft with every field, audited in the same batch, and reads it back", async () => {
    const image = await objectRow(shopA);
    const created = await createPage(shopA, {
      author: "Kent",
      content: { "en-US": "<p>Hello</p>", "sv-SE": "<h2>Hej</h2><p>Text</p>" },
      imageObjectId: image,
      kind: "post",
      metaDescription: { "sv-SE": "Beskrivning\nmed radbrytning" },
      metaTitle: { "sv-SE": "SEO-titel" },
      slug: "forsta-inlagget",
      summary: { "en-US": "   ", "sv-SE": "Sammanfattning" },
      title: { "en-US": "First post", "sv-SE": "Första inlägget" },
    });

    expect(created).toEqual({
      author: "Kent",
      content: { "en-US": "<p>Hello</p>", "sv-SE": "<h2>Hej</h2><p>Text</p>" },
      createdAt: expect.stringMatching(ISO),
      createdBy: shopA.adminUserId,
      image: {
        contentType: "image/png",
        height: 480,
        objectId: image,
        url: `${PUBLIC_BASE}/shops/${shopA.tenantId}/product_media/${image}/v1/photo.png`,
        width: 640,
      },
      imageObjectId: image,
      kind: "post",
      metaDescription: { "sv-SE": "Beskrivning\nmed radbrytning" },
      metaTitle: { "sv-SE": "SEO-titel" },
      pageId: expect.stringMatching(UUID),
      path: "/forsta-inlagget",
      publishedAt: null,
      slug: "forsta-inlagget",
      status: "draft",
      // A blank value of an optional map is dropped.
      summary: { "sv-SE": "Sammanfattning" },
      title: { "en-US": "First post", "sv-SE": "Första inlägget" },
      updatedAt: created.createdAt,
      updatedBy: shopA.adminUserId,
    });

    const row = await pageRow(created.pageId);
    expect(row).toMatchObject({
      content_json: '{"en-US":"<p>Hello</p>","sv-SE":"<h2>Hej</h2><p>Text</p>"}',
      tenant_id: shopA.tenantId,
      title_json: '{"en-US":"First post","sv-SE":"Första inlägget"}',
    });
    expect(await auditRows(shopA.tenantId, "pages.create")).toContainEqual(
      expect.objectContaining({
        actorUserId: shopA.adminUserId,
        metadata: { kind: "post", slug: "forsta-inlagget", status: "draft" },
        resourceId: created.pageId,
        resourceType: "page",
      }),
    );

    expect(
      await expectJson<PageBody>(await adminAs(shopA, "GET", `/v1/admin/pages/${created.pageId}`), 200, "read"),
    ).toEqual({ page: created });
  });

  it("publishing dates the page; a draft keeps the date; publishing again keeps the first date", async () => {
    const page = await createPage(shopA, draft("datering"));
    const published = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { status: "published" }),
      200,
      "publish",
    );
    expect(published.page.status).toBe("published");
    expect(published.page.publishedAt).toMatch(ISO);
    const firstDate = published.page.publishedAt;

    const drafted = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { status: "draft" }),
      200,
      "draft",
    );
    expect(drafted.page).toMatchObject({ publishedAt: firstDate, status: "draft" });

    const again = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { status: "published" }),
      200,
      "publish again",
    );
    expect(again.page.publishedAt).toBe(firstDate);

    // An explicit date (a post back-dated), and clearing it on a published page is refused.
    const dated = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { publishedAt: "2024-01-02T03:04:05.678Z" }),
      200,
      "date",
    );
    expect(dated.page.publishedAt).toBe("2024-01-02T03:04:05.678Z");
    await expectJson(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { publishedAt: null }),
      400,
      "clear the date of a published page",
    );

    // A page created published is dated at once.
    const direct = await createPage(shopA, draft("direkt", { status: "published" }));
    expect(direct.publishedAt).toMatch(ISO);
  });

  it("edits only the fields named, clears the nullable ones with null, and audits the fields", async () => {
    const page = await createPage(shopA, draft("redigera", { author: "A", metaTitle: { "sv-SE": "M" } }));
    const edited = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, {
        author: null,
        kind: "post",
        metaTitle: null,
        title: { "sv-SE": "Ny rubrik" },
      }),
      200,
      "edit",
    );
    expect(edited.page).toEqual({
      ...page,
      author: null,
      kind: "post",
      metaTitle: null,
      title: { "sv-SE": "Ny rubrik" },
      updatedAt: expect.stringMatching(ISO),
    });
    expect(edited.page.updatedAt >= page.updatedAt).toBe(true);
    expect((await auditRows(shopA.tenantId, "pages.update")).at(-1)).toMatchObject({
      metadata: { fields: ["kind", "title", "metaTitle", "author"], slug: "redigera" },
      resourceId: page.pageId,
    });

    // A slug can change; its content is refused on an update as on a create.
    await expectJson(await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { slug: "nytt-namn" }), 200, "rename");
    expect(
      await expectJson(
        await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { content: { "sv-SE": "<script>x</script>" } }),
        400,
        "refused",
      ),
    ).toMatchObject({ error: { code: "content_refused", reason: "script" } });
    await expectJson(await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { slug: "legal" }), 400, "reserved");
    await expectJson(await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, {}), 400, "empty");
    expect(await pageRow(page.pageId)).toMatchObject({ content_json: '{"sv-SE":"<p>Innehåll redigera</p>"}', slug: "nytt-namn" });
  });

  it("an image removed since is kept on a write that does not change it, and shows as none", async () => {
    const image = await objectRow(shopA);
    const page = await createPage(shopA, draft("borttagen-bild", { imageObjectId: image }));
    await deletePendingOrMutableObject(env.DB, context(shopA), image, NOW);

    const edited = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { imageObjectId: image, title: { "sv-SE": "Ny" } }),
      200,
      "same image sent back",
    );
    expect(edited.page).toMatchObject({ image: null, imageObjectId: image });

    const other = await objectRow(shopB);
    await expectJson(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { imageObjectId: other }),
      400,
      "a changed image is checked",
    );
    const cleared = await expectJson<PageBody>(
      await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { imageObjectId: null }),
      200,
      "cleared",
    );
    expect(cleared.page).toMatchObject({ image: null, imageObjectId: null });
  });

  it("deletes a page, audited, and answers 404 after", async () => {
    const page = await createPage(shopA, draft("radera"));
    const response = await adminAs(shopA, "DELETE", `/v1/admin/pages/${page.pageId}`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await pageRow(page.pageId)).toBeNull();
    expect((await auditRows(shopA.tenantId, "pages.delete")).at(-1)).toMatchObject({
      metadata: { kind: "page", slug: "radera", status: "draft" },
      resourceId: page.pageId,
    });

    const audits = await auditCount();
    await expectOpaque404(await adminAs(shopA, "DELETE", `/v1/admin/pages/${page.pageId}`), "again");
    await expectOpaque404(await adminAs(shopA, "GET", `/v1/admin/pages/${page.pageId}`), "read");
    await expectOpaque404(await adminAs(shopA, "PATCH", `/v1/admin/pages/${page.pageId}`, { author: "x" }), "patch");
    expect(await auditCount()).toBe(audits);
  });
});

describe("the admin list", () => {
  let shop: Tenant;

  beforeAll(async () => {
    // A shop of its own, so the counts below are exact.
    shop = await createTenant(world, {
      host: "pg-list.shops.cp4c.test",
      legallyReady: false,
      shopName: "Butik pg-list",
      tenantId: "pg-list",
    });
    for (let index = 0; index < 7; index += 1) {
      await createPage(shop, draft(`lista-${index}`, index % 2 === 0 ? { kind: "post", status: "published" } : {}));
    }
  }, 120_000);

  interface ListRow {
    createdAt: string;
    pageId: string;
    slug: string;
  }

  /** Newest first: (createdAt, pageId) strictly decreasing. */
  function expectNewestFirst(rows: readonly ListRow[]): void {
    for (let index = 1; index < rows.length; index += 1) {
      const before = rows[index - 1] as ListRow;
      const after = rows[index] as ListRow;
      expect(
        before.createdAt > after.createdAt ||
          (before.createdAt === after.createdAt && before.pageId > after.pageId),
        `${before.slug} before ${after.slug}`,
      ).toBe(true);
    }
  }

  it("walks every page once, newest first, with the cursor", async () => {
    const seen: ListRow[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const query: string = cursor === null ? "?limit=3" : `?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const body: { nextCursor: string | null; pages: ListRow[] } = await expectJson(
        await adminAs(shop, "GET", `/v1/admin/pages${query}`),
        200,
        "list",
      );
      expect(body.pages.length).toBeLessThanOrEqual(3);
      seen.push(...body.pages);
      cursor = body.nextCursor;
      rounds += 1;
    } while (cursor !== null && rounds < 10);

    expect(rounds).toBe(3);
    expect(new Set(seen.map((row) => row.slug))).toEqual(
      new Set(Array.from({ length: 7 }, (_value, index) => `lista-${index}`)),
    );
    expect(seen).toHaveLength(7);
    expectNewestFirst(seen);
  });

  it("filters by kind and status, with the list shape", async () => {
    const posts = await expectJson<{ nextCursor: string | null; pages: Array<ListRow & Record<string, unknown>> }>(
      await adminAs(shop, "GET", "/v1/admin/pages?kind=post&status=published"),
      200,
      "posts",
    );
    expect(posts.nextCursor).toBeNull();
    expect(posts.pages.map((page) => page.slug).sort()).toEqual(["lista-0", "lista-2", "lista-4", "lista-6"]);
    expectNewestFirst(posts.pages);
    const first = posts.pages[0] as ListRow & Record<string, unknown>;
    expect(first).toEqual({
      createdAt: expect.stringMatching(ISO),
      kind: "post",
      pageId: expect.stringMatching(UUID),
      path: `/${first.slug}`,
      publishedAt: expect.stringMatching(ISO),
      slug: first.slug,
      status: "published",
      title: { "sv-SE": `Rubrik ${first.slug}` },
      updatedAt: expect.stringMatching(ISO),
    });
    const drafts = await expectJson<{ pages: unknown[] }>(
      await adminAs(shop, "GET", "/v1/admin/pages?status=draft"),
      200,
      "drafts",
    );
    expect(drafts.pages).toHaveLength(3);
  });

  it.each([
    ["an unknown parameter", "?q=x"],
    ["a repeated parameter", "?kind=post&kind=page"],
    ["a bad kind", "?kind=legal"],
    ["a bad status", "?status=live"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a limit that is not a number", "?limit=ten"],
    ["a malformed cursor", "?cursor=nope"],
    ["a cursor with a bad date", `?cursor=${encodeURIComponent("2026-13-45T00:00:00.000Z~x")}`],
  ])("refuses %s", async (_label, query) => {
    await expectJson(await adminAs(shop, "GET", `/v1/admin/pages${query}`), 400, query);
  });
});
