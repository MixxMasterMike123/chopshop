/**
 * Everything this Worker writes into the storefront's HTML (brief E rule 3),
 * and the one rule for all of it: a value from the API reaches the page only
 * through `escapeHtml` (text and attribute values), `jsonForScript` (the
 * JSON-LD block) or `sanitizeBodyHtml` (the body text the API built as HTML).
 * A product named `</title><script>` stays text.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * JSON inside `<script type="application/ld+json">`: `<`, `>` and `&` as
 * unicode escapes, so no value can close the element or open a comment, and
 * U+2028/U+2029 escaped for old parsers. Still valid JSON with the same value.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * The storefront's root (`/<shop>`, or "" on a shop's own domain) for the
 * client (src/api/client.js reads it). Written on every page this Worker
 * serves for a shop, with or without a head of its own.
 */
export function rootMetaHtml(root: string): string {
  return `<meta name="storefront-root" content="${escapeHtml(root)}">`;
}

/** The head of one page, every address in it already absolute. */
export interface PageHead {
  canonicalUrl: string | null;
  description: string | null;
  imageUrl: string | null;
  /** Already made absolute; null ⇒ no JSON-LD block. */
  jsonLd: unknown;
  robots: string | null;
  title: string;
}

export function pageHeadHtml(head: PageHead): string {
  const tags: string[] = [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(head.title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(head.title)}">`,
  ];
  if (head.description !== null) {
    const description = escapeHtml(head.description);
    tags.push(
      `<meta name="description" content="${description}">`,
      `<meta property="og:description" content="${description}">`,
      `<meta name="twitter:description" content="${description}">`,
    );
  }
  if (head.canonicalUrl !== null) {
    const canonical = escapeHtml(head.canonicalUrl);
    tags.push(
      `<link rel="canonical" href="${canonical}">`,
      `<meta property="og:url" content="${canonical}">`,
    );
  }
  if (head.robots !== null) {
    tags.push(`<meta name="robots" content="${escapeHtml(head.robots)}">`);
  }
  if (head.imageUrl !== null) {
    tags.push(`<meta property="og:image" content="${escapeHtml(head.imageUrl)}">`);
  }
  if (head.jsonLd !== null && head.jsonLd !== undefined) {
    tags.push(`<script type="application/ld+json">${jsonForScript(head.jsonLd)}</script>`);
  }
  return tags.join("");
}

// The tags of the build's own head that a page's head replaces.
const REPLACED_HEAD_TAGS = [
  "title",
  'meta[name="description"]',
  'meta[name="robots"]',
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'link[rel="canonical"]',
];

/**
 * The application's HTML for one address. `root` null ⇒ no root is written
 * (the shared host without a shop). `page` null ⇒ the build's head is left as
 * it is. `bodyHtml` must already be sanitized.
 */
export function renderShell(
  shell: Response,
  root: string | null,
  page: { bodyHtml: string | null; head: PageHead } | null,
): Response {
  let rewriter = new HTMLRewriter();

  if (page !== null) {
    for (const selector of REPLACED_HEAD_TAGS) {
      rewriter = rewriter.on(selector, {
        element: (element) => {
          element.remove();
        },
      });
    }
  }

  const appended = `${root === null ? "" : rootMetaHtml(root)}${
    page === null ? "" : pageHeadHtml(page.head)
  }`;
  if (appended !== "") {
    rewriter = rewriter.on("head", {
      element: (element) => {
        element.append(appended, { html: true });
      },
    });
  }

  const bodyHtml = page?.bodyHtml ?? null;
  if (bodyHtml !== null && bodyHtml !== "") {
    rewriter = rewriter.on("#root", {
      element: (element) => {
        element.setInnerContent(bodyHtml, { html: true });
      },
    });
  }

  return rewriter.transform(shell);
}

// ── The body text (brief D: "escaped by the server") — a second fence ──────

/** Removed WITH their content: anything that runs, embeds, styles or hides. */
const DROP_WITH_CONTENT = new Set([
  "applet", "audio", "base", "button", "canvas", "embed", "form", "frame",
  "frameset", "head", "iframe", "input", "link", "math", "meta", "noembed",
  "noframes", "noscript", "object", "option", "plaintext", "portal", "script",
  "select", "source", "style", "svg", "template", "textarea", "title", "track",
  "video", "xmp",
]);

/** Kept, with no attribute except those `sanitizeBodyHtml` names. */
const KEEP = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite",
  "code", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img",
  "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s",
  "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);

// Attribute values that are kept as they came must hold no character that
// could end or re-quote the attribute when the tag is written back out.
const PLAIN_TEXT_VALUE = /^[^"'<>&`\u0000-\u001f]*$/;
const DIMENSION_VALUE = /^[1-9][0-9]{0,4}$/;
// A shop-relative link in the body: a path only, of the characters a URL
// path keeps as they are. No query, no fragment, no scheme.
const BODY_LINK = /^\/(?![/\\])[A-Za-z0-9\-._~%/]*$/;
const OBJECT_KEY = /^[A-Za-z0-9\-._~%/]+$/;

export interface BodyRules {
  /** The absolute path of a shop-relative link, or null to drop the link. */
  linkPath(relative: string): string | null;
  /** The public object origin, or null: then no image is kept. */
  publicObjectOrigin: string | null;
}

/**
 * Keeps the text and the plain structure of the body the API built, and
 * nothing that can run or reach elsewhere: dangerous elements go with their
 * content, unknown elements go and keep their text, every attribute goes
 * except a link's shop-relative `href` (rewritten under the shop's root) and
 * an image's `src` on the public object origin with its `alt`, `width` and
 * `height`. Comments go. Text is passed on exactly as it came, so what the
 * API escaped stays escaped.
 */
export async function sanitizeBodyHtml(html: string, rules: BodyRules): Promise<string> {
  const imagePrefix =
    rules.publicObjectOrigin === null ? null : `${rules.publicObjectOrigin}/`;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element: (element) => {
        const tag = element.tagName.toLowerCase();
        if (DROP_WITH_CONTENT.has(tag)) {
          element.remove();
          return;
        }
        if (!KEEP.has(tag)) {
          element.removeAndKeepContent();
          return;
        }

        const keep = new Map<string, string>();
        if (tag === "a") {
          const href = element.getAttribute("href");
          const path = href !== null && BODY_LINK.test(href) ? rules.linkPath(href) : null;
          if (path !== null && BODY_LINK.test(path)) {
            keep.set("href", path);
          }
        } else if (tag === "img") {
          const src = element.getAttribute("src");
          if (
            imagePrefix === null ||
            src === null ||
            !src.startsWith(imagePrefix) ||
            !OBJECT_KEY.test(src.slice(imagePrefix.length))
          ) {
            element.remove();
            return;
          }
          keep.set("src", src);
          for (const name of ["width", "height"]) {
            const value = element.getAttribute(name);
            if (value !== null && DIMENSION_VALUE.test(value)) {
              keep.set(name, value);
            }
          }
          const alt = element.getAttribute("alt");
          if (alt !== null && PLAIN_TEXT_VALUE.test(alt)) {
            keep.set("alt", alt);
          }
        }

        const names: string[] = [];
        for (const [name] of element.attributes) {
          if (name !== undefined) {
            names.push(name);
          }
        }
        for (const name of names) {
          element.removeAttribute(name);
        }
        for (const [name, value] of keep) {
          element.setAttribute(name, value);
        }
      },
    })
    .onDocument({
      comments: (comment) => {
        comment.remove();
      },
    });

  return rewriter
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .text();
}
