import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  jsonForScript,
  pageHeadHtml,
  renderShell,
  rootMetaHtml,
  sanitizeBodyHtml,
  type BodyRules,
} from "../web/src/html";

/**
 * CP4-E — what the web Worker writes into the storefront's HTML. Every value
 * from the API is escaped, JSON-encoded for a script block, or sanitized.
 */

const SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<title>My Shop</title>
<meta name="description" content="Quality products, delivered." />
<meta property="og:title" content="My Shop" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#459CA8" />
</head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;

const HOSTILE = `</title><script>alert("x")</script>"'&<>`;

function shell(): Response {
  return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const RULES: BodyRules = {
  linkPath: (relative) => `/sillmans${relative}`,
  publicObjectOrigin: "https://pub.test.invalid",
};

describe("escaping", () => {
  it("escapes the five characters that matter in text and attributes", () => {
    expect(escapeHtml(HOSTILE)).toBe(
      "&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot;&#39;&amp;&lt;&gt;",
    );
  });

  it("keeps JSON-LD from closing its script element, and keeps it JSON", () => {
    const value = { name: "</script><script>alert(1)</script>", note: "a & b <!-- c -->\u2028" };
    const encoded = jsonForScript(value);
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain(">");
    expect(encoded).not.toContain("&");
    expect(encoded).not.toContain("\u2028");
    expect(JSON.parse(encoded)).toEqual(value);
  });

  it("writes the root as an attribute value", () => {
    expect(rootMetaHtml("/sillmans")).toBe('<meta name="storefront-root" content="/sillmans">');
    expect(rootMetaHtml("")).toBe('<meta name="storefront-root" content="">');
  });
});

describe("the head of a page", () => {
  it("writes every tag with its value escaped", () => {
    const html = pageHeadHtml({
      canonicalUrl: 'https://web.test.invalid/sillmans/product/a"b',
      description: HOSTILE,
      imageUrl: "https://pub.test.invalid/shops/x/v1/a.jpg",
      jsonLd: { name: HOSTILE },
      robots: "noindex",
      title: HOSTILE,
    });

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("</title><script>");
    expect(html).toContain(`<title>${escapeHtml(HOSTILE)}</title>`);
    expect(html).toContain(`<meta name="description" content="${escapeHtml(HOSTILE)}">`);
    expect(html).toContain('<link rel="canonical" href="https://web.test.invalid/sillmans/product/a&quot;b">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta property="og:image" content="https://pub.test.invalid/shops/x/v1/a.jpg">');
    expect(html).toContain('<script type="application/ld+json">{"name":"\\u003c/title\\u003e');
  });

  it("leaves out what the page does not have", () => {
    const html = pageHeadHtml({
      canonicalUrl: null,
      description: null,
      imageUrl: null,
      jsonLd: null,
      robots: null,
      title: "T",
    });
    expect(html).not.toContain("description");
    expect(html).not.toContain("canonical");
    expect(html).not.toContain("robots");
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("ld+json");
  });
});

describe("renderShell", () => {
  it("replaces the build's head with the page's and fills the root element", async () => {
    const html = await renderShell(shell(), "/sillmans", {
      bodyHtml: "<h1>Tröja</h1><p>199 kr</p>",
      head: {
        canonicalUrl: "https://web.test.invalid/sillmans/product/t",
        description: "En tröja",
        imageUrl: null,
        jsonLd: { "@type": "Product" },
        robots: null,
        title: HOSTILE,
      },
    }).text();

    // Exactly one title and one description: the build's are gone.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).not.toContain("My Shop");
    expect(html).not.toContain("Quality products, delivered.");
    // The product named </title><script> stays text.
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain(`<title>${escapeHtml(HOSTILE)}</title>`);
    // Untouched: the rest of the build's head and its script.
    expect(html).toContain('<meta name="theme-color" content="#459CA8" />');
    expect(html).toContain('<script type="module" src="/assets/index-abc.js"></script>');
    expect(html).toContain('<meta name="storefront-root" content="/sillmans">');
    expect(html).toContain('<div id="root"><h1>Tröja</h1><p>199 kr</p></div>');
  });

  it("leaves the build's head as it is without a page, and still writes the root", async () => {
    const html = await renderShell(shell(), "", null).text();
    expect(html).toContain("<title>My Shop</title>");
    expect(html).toContain('<meta name="description" content="Quality products, delivered." />');
    expect(html).toContain('<meta name="storefront-root" content="">');
    expect(html).toContain('<div id="root"></div>');
  });

  it("writes no root at all when there is no shop", async () => {
    const html = await renderShell(shell(), null, null).text();
    expect(html).toBe(SHELL);
  });
});

describe("sanitizeBodyHtml", () => {
  it.each([
    ["a script element", `<p>a</p><script>alert(1)</script>`, "<p>a</p>"],
    ["a style element", `<style>body{display:none}</style><p>a</p>`, "<p>a</p>"],
    ["an iframe", `<iframe src="https://evil.test"></iframe>b`, "b"],
    ["an svg with a script", `<svg><script>alert(1)</script></svg>c`, "c"],
    ["a noscript", `<noscript><img src=x onerror=alert(1)></noscript>d`, "d"],
    ["a template", `<template><script>alert(1)</script></template>e`, "e"],
    ["a form", `<form action="https://evil.test"><input name=x></form>f`, "f"],
    ["an event attribute", `<p onclick="alert(1)" class="x" style="color:red">g</p>`, "<p>g</p>"],
    ["a javascript link", `<a href="javascript:alert(1)">h</a>`, "<a>h</a>"],
    ["an absolute link", `<a href="https://evil.test/x">i</a>`, "<a>i</a>"],
    ["a protocol-relative link", `<a href="//evil.test/x">j</a>`, "<a>j</a>"],
    ["a link with a query", `<a href="/product/x?y=&quot;z">k</a>`, "<a>k</a>"],
    ["an image from elsewhere", `<img src="https://evil.test/x.png" onerror="alert(1)">l`, "l"],
    ["an image with a script src", `<img src="javascript:alert(1)">m`, "m"],
    ["a comment", `<!-- secret --><p>n</p>`, "<p>n</p>"],
    ["an unknown element", `<blink>o</blink>`, "o"],
    ["a meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.test">p`, "p"],
    ["a base element", `<base href="https://evil.test/">q`, "q"],
  ])("removes %s", async (_label, input, output) => {
    await expect(sanitizeBodyHtml(input, RULES)).resolves.toBe(output);
  });

  it("keeps escaped text as text", async () => {
    await expect(
      sanitizeBodyHtml("<p>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>", RULES),
    ).resolves.toBe("<p>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("puts a shop-relative link under the shop's root", async () => {
    await expect(
      sanitizeBodyHtml('<a href="/product/t-shirt" target="_blank" rel="x">T</a>', RULES),
    ).resolves.toBe('<a href="/sillmans/product/t-shirt">T</a>');
  });

  it("drops the link when the root check refuses it", async () => {
    await expect(
      sanitizeBodyHtml('<a href="/../other">T</a>', { ...RULES, linkPath: () => null }),
    ).resolves.toBe("<a>T</a>");
  });

  it("keeps a public image with its plain alt text and size", async () => {
    await expect(
      sanitizeBodyHtml(
        '<img src="https://pub.test.invalid/shops/s/product_media/o1/v1/a.jpg" alt="En tröja" width="800" height="600" onload="x()">',
        RULES,
      ),
    ).resolves.toBe(
      '<img src="https://pub.test.invalid/shops/s/product_media/o1/v1/a.jpg" width="800" height="600" alt="En tröja">',
    );
  });

  it("drops an alt text or a size that is not plain", async () => {
    await expect(
      sanitizeBodyHtml(
        `<img src="https://pub.test.invalid/a.jpg" alt='a"b' width="80px" height="-1">`,
        RULES,
      ),
    ).resolves.toBe('<img src="https://pub.test.invalid/a.jpg">');
  });

  it("drops every image when there is no public object origin", async () => {
    await expect(
      sanitizeBodyHtml('<img src="https://pub.test.invalid/a.jpg">r', { ...RULES, publicObjectOrigin: null }),
    ).resolves.toBe("r");
  });

  it("keeps the plain structure of an article", async () => {
    const article =
      "<article><h1>Nyhet</h1><p>Text <strong>fet</strong> och <em>kursiv</em>.</p>" +
      "<ul><li>ett</li><li>två</li></ul><blockquote>citat</blockquote></article>";
    await expect(sanitizeBodyHtml(article, RULES)).resolves.toBe(article);
  });
});
