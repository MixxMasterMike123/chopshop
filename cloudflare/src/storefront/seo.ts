import { ELIGIBLE_PRODUCTS_FROM } from "../catalog/eligibility";
import { getPublicProductByRef } from "../catalog/public-catalog";
import { isPlainObject } from "../platform/tenant-config";
import { PUBLIC_LEGAL_PAGES, type PublicLegalKey } from "../routes/public-legal";
import type { PublicImage } from "../storage/public-objects";
import { resolvePublicImages } from "../storage/public-objects";
import {
  ALL_PRODUCTS_PATH,
  categoryPath,
  collectionPath,
  HOME_PATH,
  pagePath,
  productPath,
  slugify,
  tagPath,
} from "./addresses";
import {
  getPublicStorefrontVersioned,
  type PublicStorefrontResponse,
} from "./public-storefront";
import { eligibilityPredicate, isPreview, type StorefrontTenant } from "./preview";
import { findRedirect, normalizeStorefrontPath } from "./redirects";

/**
 * CP4-D — the head and the readable body of a storefront page, for search
 * engines and link previews (D88): `GET /v1/seo?path=<path under the root>`.
 *
 * The web Worker asks once per navigation and gets ONE of:
 *   { redirect: { to, status: 301 } }   the shop forwards this path;
 *   { page: SeoPage }                   a public home, product, collection,
 *                                       category, tag, page, post or legal page;
 *   404                                 anything else: the application is served
 *                                       as it is.
 *
 * PUBLIC FIELDS ONLY, BY CONSTRUCTION. Everything about the shop comes from
 * the public storefront response (the identity's allowlist, resolved images,
 * the resolved menu); a product from the public product shape behind THE
 * predicate; a collection, page or post only when published; a legal page only
 * when the shop has adopted it. Every string of `bodyHtml` is escaped here;
 * `jsonLd` is data the web Worker serialises for a script element.
 *
 * Every storefront address in the answer is a path relative to the shop's
 * root; inside `jsonLd` it stands as `{ "@relative": "<path>" }`, an object
 * with that ONE key, which the web Worker replaces by the absolute address.
 */

export interface SeoPage {
  bodyHtml: string;
  canonicalPath: string;
  description: string | null;
  image: PublicImage | null;
  jsonLd: Record<string, unknown>;
  robots: string | null;
  title: string;
}

export type SeoAnswer =
  | { page: SeoPage }
  | { redirect: { status: 301; to: string } };

// ── text ────────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const DESCRIPTION_MAX = 160;
const TITLE_MAX = 200;

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The first `length` code units, never ending in half of a surrogate pair. */
function cut(value: string, length: number): string {
  return value.slice(0, Math.max(0, length)).replace(/[\uD800-\uDBFF]$/, "");
}

/** A meta description: one line, at most 160 characters (157 + "..."). */
export function truncateDescription(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const line = collapse(value);
  if (line.length === 0) {
    return null;
  }
  return line.length > DESCRIPTION_MAX ? `${cut(line, DESCRIPTION_MAX - 3).trimEnd()}...` : line;
}

function boundedTitle(value: string): string {
  const line = collapse(value);
  return line.length > TITLE_MAX ? `${cut(line, TITLE_MAX - 3).trimEnd()}...` : line;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  Auml: "Ä",
  Aring: "Å",
  Ouml: "Ö",
  amp: "&",
  apos: "'",
  auml: "ä",
  aring: "å",
  copy: "©",
  eacute: "é",
  euro: "€",
  gt: ">",
  hellip: "…",
  laquo: "«",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  ouml: "ö",
  quot: '"',
  raquo: "»",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      const printable =
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        (code >= 0x20 && code < 0x7f) ||
        (code >= 0xa0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff));
      return printable ? String.fromCodePoint(code) : " ";
    }
    // Own members only: `&toString;` is not an entity.
    return Object.hasOwn(NAMED_ENTITIES, body) ? (NAMED_ENTITIES[body] as string) : whole;
  });
}

// Removed WITH their content; everything else keeps its text.
const RAW_TEXT_ELEMENTS = new Set([
  "iframe", "math", "noscript", "object", "script", "style", "svg", "template", "textarea", "title",
]);
const BLOCK_ELEMENTS = new Set([
  "article", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "td", "th", "tr", "ul",
]);
const TAG_NAME = /^\/?\s*([A-Za-z][A-Za-z0-9-]*)/;

/**
 * The readable text of stored HTML (a page's content, an adopted legal text):
 * a single forward scan, linear in the input, never a parser. Tags go; the
 * content of script-like elements goes with them; block ends become paragraph
 * breaks; entities are decoded. The result is PLAIN TEXT, escaped again by
 * whoever writes it into HTML, so nothing of the input can survive as markup.
 */
export function htmlToText(html: string, maxLength: number): string[] {
  const out: string[] = [];
  let length = 0;
  let index = 0;
  let skipping: string | null = null;
  const push = (text: string): void => {
    out.push(text);
    length += text.length;
  };

  while (index < html.length && length < maxLength * 2) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      if (skipping === null) {
        push(html.slice(index));
      }
      break;
    }
    if (skipping === null) {
      push(html.slice(index, open));
    }
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      break;
    }
    const tag = html.slice(open + 1, close);
    const name = TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? null;
    const closing = tag.trimStart().startsWith("/");
    index = close + 1;

    if (skipping !== null) {
      if (closing && name === skipping) {
        skipping = null;
      }
      continue;
    }
    if (name === null) {
      continue;
    }
    if (!closing && RAW_TEXT_ELEMENTS.has(name) && !tag.trimEnd().endsWith("/")) {
      skipping = name;
      continue;
    }
    if (name === "br") {
      push("\n");
    } else if (BLOCK_ELEMENTS.has(name)) {
      push("\n\n");
    }
  }

  return textParagraphs(decodeEntities(out.join("")), maxLength);
}

/**
 * Plain text as paragraphs (split on blank lines, white space collapsed), at
 * most `maxLength` characters in all; the last one is cut with an ellipsis.
 */
export function textParagraphs(text: string, maxLength: number): string[] {
  const paragraphs: string[] = [];
  let budget = maxLength;
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const line = collapse(block);
    if (line.length === 0) {
      continue;
    }
    if (line.length >= budget) {
      paragraphs.push(`${cut(line, budget - 1).trimEnd()}…`);
      break;
    }
    paragraphs.push(line);
    budget -= line.length;
  }
  return paragraphs;
}

/**
 * The body text, built block by block under a size budget: a block is added
 * whole or not at all, so the result is always well-formed, and it always
 * stays under what the web Worker accepts.
 */
class BodyHtml {
  private readonly parts: string[] = [];
  private length = 0;

  constructor(private readonly max: number) {}

  add(html: string): boolean {
    if (this.length + html.length > this.max) {
      return false;
    }
    this.parts.push(html);
    this.length += html.length;
    return true;
  }

  /** `open` + as many `items` as fit + `close`; nothing when none fits. */
  list(open: string, items: readonly string[], close: string): void {
    let room = this.max - this.length - open.length - close.length;
    const kept: string[] = [];
    for (const item of items) {
      if (item.length > room) {
        break;
      }
      kept.push(item);
      room -= item.length;
    }
    if (kept.length > 0) {
      this.add(`${open}${kept.join("")}${close}`);
    }
  }

  paragraphs(texts: readonly string[]): void {
    for (const text of texts) {
      if (!this.add(`<p>${escapeHtml(text)}</p>`)) {
        return;
      }
    }
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** Well under the web Worker's 200 000 (cloudflare/web/src/seo.ts). */
export const BODY_HTML_MAX = 100_000;
const BODY_TEXT_MAX = 20_000;
const LIST_MAX = 60;

function link(path: string, text: string): string {
  return `<a href="${escapeHtml(path)}">${escapeHtml(text)}</a>`;
}

function imageTag(image: PublicImage, alt: string): string {
  const size =
    image.width !== null && image.height !== null
      ? ` width="${image.width}" height="${image.height}"`
      : "";
  return `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(alt)}"${size}>`;
}

function formatPrice(minor: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { currency, style: "currency" }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** The schema.org price: major units, two decimals, as a string. */
function schemaPrice(minor: number): string {
  return (minor / 100).toFixed(2);
}

function relative(path: string): { "@relative": string } {
  return { "@relative": path };
}

// ── the address grammar, read back ──────────────────────────────────────────
//
// The shop's legal pages, their addresses and titles are C's
// PUBLIC_LEGAL_PAGES (src/routes/public-legal.ts), the one list of them.

/** First segments that are pages of the application, never a content page. */
const APPLICATION_SEGMENTS = new Set([
  "_api", "angra", "assets", "cart", "checkout", "images", "kategori", "legal", "order-confirmation",
  "order-return", "product", "produkter", "rapportera-intrang", "samling", "tagg",
]);

export type StorefrontRoute =
  | { kind: "all_products" }
  | { kind: "category"; slug: string }
  | { kind: "collection"; handle: string }
  | { kind: "home" }
  | { kind: "legal"; key: PublicLegalKey }
  | { kind: "page"; slug: string }
  | { kind: "product"; handle: string }
  | { kind: "tag"; slug: string };

/** Which page a NORMAL-FORM path names, by the address grammar; null = none. */
export function parseStorefrontRoute(normal: string): StorefrontRoute | null {
  if (normal === HOME_PATH) {
    return { kind: "home" };
  }
  if (normal === ALL_PRODUCTS_PATH) {
    return { kind: "all_products" };
  }
  const legal = PUBLIC_LEGAL_PAGES.find((page) => page.path === normal);
  if (legal !== undefined) {
    return { key: legal.key, kind: "legal" };
  }
  const segments = normal.slice(1).split("/");
  const [first, second] = segments;
  if (first === undefined) {
    return null;
  }
  if (segments.length === 2 && second !== undefined) {
    switch (first) {
      case "product":
        return { handle: second, kind: "product" };
      case "kategori":
        return { kind: "category", slug: second };
      case "tagg":
        return { kind: "tag", slug: second };
      case "samling":
        return { handle: second, kind: "collection" };
      default:
        return null;
    }
  }
  if (segments.length === 1 && !APPLICATION_SEGMENTS.has(first)) {
    return { kind: "page", slug: first };
  }
  return null;
}

// ── reads of other builders' tables ─────────────────────────────────────────
//
// A product page reads through A's getPublicProductByRef. The reads below
// are still D's own: each names only columns CP4_BRIEFS.md fixes (A:
// products.handle, .category, .sort_order, product_tags; B: collections,
// collection_products; C: pages) and goes through ELIGIBLE_PRODUCTS_FROM +
// PUBLIC_ELIGIBILITY_PREDICATE wherever a product is shown. Moving them to
// the functions of A, B and C would change what they answer (the order of a
// list, a blank text, the platform terms): docs/cf-port/CP4_K_REPORT.md.

const PRODUCT_ORDER =
  "product.sort_order IS NULL, product.sort_order, publication.public_name, product.product_id";

interface ProductLink {
  name: string;
  path: string;
}

async function productLinks(
  statement: D1PreparedStatement,
): Promise<ProductLink[]> {
  const rows = await statement.all<{ handle: string | null; name: string }>();
  const links: ProductLink[] = [];
  for (const row of rows.results) {
    if (typeof row.handle === "string" && row.handle.length > 0) {
      links.push({ name: row.name, path: productPath(row.handle) });
    }
  }
  return links;
}

const PRODUCT_LINK_COLUMNS = `SELECT publication.public_name AS name, product.handle AS handle
   ${ELIGIBLE_PRODUCTS_FROM}`;

function listAllProductLinks(db: D1Database, tenant: StorefrontTenant): Promise<ProductLink[]> {
  const tenantId = tenant.tenantId;
  return productLinks(
    db
      .prepare(
        `${PRODUCT_LINK_COLUMNS}
         WHERE publication.tenant_id = ? AND product.tenant_id = ?
           AND ${eligibilityPredicate(tenant)}
         ORDER BY ${PRODUCT_ORDER}
         LIMIT ${LIST_MAX}`,
      )
      .bind(tenantId, tenantId),
  );
}

// A category or a tag is found by its KEY, its address form (0040
// `products.category_key`, `product_tags.tag_key`, made by the same slugify):
// one indexed lookup, whatever the number of categories and tags of the shop.
// Names that share one key are one page (`/kategori/rokt` is "Rökt" and
// "rokt"); the page is titled with the first of them.
const NAMES_MAX = 90;

function listCategoryProductLinks(
  db: D1Database,
  tenant: StorefrontTenant,
  key: string,
): Promise<ProductLink[]> {
  const tenantId = tenant.tenantId;
  return productLinks(
    db
      .prepare(
        `${PRODUCT_LINK_COLUMNS}
         WHERE publication.tenant_id = ? AND product.tenant_id = ?
           AND product.category_key = ?
           AND ${eligibilityPredicate(tenant)}
         ORDER BY ${PRODUCT_ORDER}
         LIMIT ${LIST_MAX}`,
      )
      .bind(tenantId, tenantId, key),
  );
}

function listTagProductLinks(
  db: D1Database,
  tenant: StorefrontTenant,
  key: string,
): Promise<ProductLink[]> {
  const tenantId = tenant.tenantId;
  return productLinks(
    db
      .prepare(
        `${PRODUCT_LINK_COLUMNS}
         WHERE publication.tenant_id = ? AND product.tenant_id = ?
           AND EXISTS (
             SELECT 1 FROM product_tags AS tagged
             WHERE tagged.tenant_id = product.tenant_id
               AND tagged.product_id = product.product_id
               AND tagged.tag_key = ?
           )
           AND ${eligibilityPredicate(tenant)}
         ORDER BY ${PRODUCT_ORDER}
         LIMIT ${LIST_MAX}`,
      )
      .bind(tenantId, tenantId, key),
  );
}

function listCollectionMemberLinks(
  db: D1Database,
  tenant: StorefrontTenant,
  collectionId: string,
): Promise<ProductLink[]> {
  const tenantId = tenant.tenantId;
  return productLinks(
    db
      .prepare(
        `${PRODUCT_LINK_COLUMNS}
         INNER JOIN collection_products AS member
           ON member.product_id = product.product_id
          AND member.tenant_id = product.tenant_id
         WHERE publication.tenant_id = ? AND product.tenant_id = ?
           AND member.collection_id = ?
           AND ${eligibilityPredicate(tenant)}
         ORDER BY member.position, product.product_id
         LIMIT ${LIST_MAX}`,
      )
      .bind(tenantId, tenantId, collectionId),
  );
}

/** The names of the shop's PUBLIC products' categories that share `key`. */
export async function publicCategoryNames(
  db: D1Database,
  tenant: StorefrontTenant,
  key: string,
): Promise<string[]> {
  const tenantId = tenant.tenantId;
  const rows = await db
    .prepare(
      `SELECT DISTINCT product.category AS value
       ${ELIGIBLE_PRODUCTS_FROM}
       WHERE publication.tenant_id = ? AND product.tenant_id = ?
         AND product.category_key = ?
         AND product.category IS NOT NULL
         AND ${eligibilityPredicate(tenant)}
       ORDER BY value
       LIMIT ${NAMES_MAX}`,
    )
    .bind(tenantId, tenantId, key)
    .all<{ value: string }>();
  return rows.results.map((row) => row.value);
}

/** The names of the shop's PUBLIC products' tags that share `key`. */
export async function publicTagNames(
  db: D1Database,
  tenant: StorefrontTenant,
  key: string,
): Promise<string[]> {
  const tenantId = tenant.tenantId;
  const rows = await db
    .prepare(
      `SELECT DISTINCT tagged.tag AS value
       ${ELIGIBLE_PRODUCTS_FROM}
       INNER JOIN product_tags AS tagged
         ON tagged.product_id = product.product_id
        AND tagged.tenant_id = product.tenant_id
       WHERE publication.tenant_id = ? AND product.tenant_id = ?
         AND tagged.tag_key = ?
         AND ${eligibilityPredicate(tenant)}
       ORDER BY value
       LIMIT ${NAMES_MAX}`,
    )
    .bind(tenantId, tenantId, key)
    .all<{ value: string }>();
  return rows.results.map((row) => row.value);
}

interface CollectionRow {
  collection_id: string;
  description: string | null;
  handle: string;
  image_object_id: string | null;
  rule_tag: string | null;
  title: string;
  type: string;
}

interface PageRow {
  author: string | null;
  content_json: string;
  image_object_id: string | null;
  kind: string;
  meta_description_json: string | null;
  meta_title_json: string | null;
  published_at: string | null;
  slug: string;
  summary_json: string | null;
  title_json: string;
}

/**
 * A text of a per-language object (`{ "sv-SE": "…" }`, D84) in `lang`, else
 * the first string it holds, else null.
 */
export function pickLanguage(json: string | null, lang: string): string | null {
  if (json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed === "string") {
    return parsed;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const wanted = Object.hasOwn(parsed, lang) ? parsed[lang] : undefined;
  if (typeof wanted === "string" && wanted.trim().length > 0) {
    return wanted;
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Whether the shop has a legal page to show: its latest adoption of the
 * legal pages holds that page's text (C's GET /v1/legal/:key answers 404
 * otherwise), or — for the platform's terms — a version is published.
 */
export async function legalPageTexts(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<{ acceptedAt: string | null; platformTermsAt: string | null; texts: Map<PublicLegalKey, string> }> {
  const [adoption, terms] = await db.batch<
    { accepted_at: string; texts_json: string } | { published_at: string }
  >([
    db
      .prepare(
        `SELECT texts_json, accepted_at FROM legal_acceptances
         WHERE tenant_id = ? AND type = 'legalPages'
         ORDER BY accepted_at DESC, acceptance_id DESC
         LIMIT 1`,
      )
      .bind(tenantId),
    db
      .prepare(
        `SELECT published_at FROM platform_terms_versions
         WHERE published_at <= ?
         ORDER BY published_at DESC, version DESC
         LIMIT 1`,
      )
      .bind(new Date(now).toISOString()),
  ]);
  const texts = new Map<PublicLegalKey, string>();
  const adopted = adoption?.results[0] as { accepted_at: string; texts_json: string } | undefined;
  if (adopted !== undefined) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(adopted.texts_json);
    } catch {
      parsed = null;
    }
    if (isPlainObject(parsed)) {
      for (const page of PUBLIC_LEGAL_PAGES) {
        const text = parsed[page.key];
        if (page.key !== "plattformsvillkor" && typeof text === "string" && text.trim().length > 0) {
          texts.set(page.key, text);
        }
      }
    }
  }
  const published = terms?.results[0] as { published_at: string } | undefined;
  return {
    acceptedAt: adopted?.accepted_at ?? null,
    platformTermsAt: published?.published_at ?? null,
    texts,
  };
}

// ── the pages ───────────────────────────────────────────────────────────────

interface Shop {
  name: string;
  storefront: PublicStorefrontResponse;
}

function withShop(title: string, shop: Shop): string {
  return boundedTitle(`${title} | ${shop.name}`);
}

function itemList(links: readonly ProductLink[]): Record<string, unknown> {
  return {
    "@type": "ItemList",
    itemListElement: links.map((entry, index) => ({
      "@type": "ListItem",
      name: entry.name,
      position: index + 1,
      url: relative(entry.path),
    })),
  };
}

function productListBody(body: BodyHtml, links: readonly ProductLink[]): void {
  body.list(
    "<ul>",
    links.map((entry) => `<li>${link(entry.path, entry.name)}</li>`),
    "</ul>",
  );
}

function homePage(shop: Shop): SeoPage {
  const { identity, branding, menu } = shop.storefront;
  const tagline = identity.tagline ?? null;
  const description = truncateDescription(identity.companyDescription ?? tagline ?? shop.name);
  const socialLinks = Object.values(identity.social ?? {});

  const body = new BodyHtml(BODY_HTML_MAX);
  body.add(`<h1>${escapeHtml(identity.heroHeadline ?? shop.name)}</h1>`);
  const subtitle = identity.heroSubtitle ?? tagline;
  if (subtitle !== null) {
    body.add(`<p>${escapeHtml(subtitle)}</p>`);
  }
  if (identity.introTitle !== undefined) {
    body.add(`<h2>${escapeHtml(identity.introTitle)}</h2>`);
  }
  if (identity.introBody !== undefined) {
    body.paragraphs(textParagraphs(identity.introBody, BODY_TEXT_MAX));
  }
  const navigation = menu.filter((entry) => entry.path !== null);
  body.list(
    "<nav><ul>",
    [
      ...navigation.map((entry) => `<li>${link(entry.path as string, entry.label)}</li>`),
      `<li>${link(ALL_PRODUCTS_PATH, "Alla produkter")}</li>`,
    ],
    "</ul></nav>",
  );

  return {
    bodyHtml: body.toString(),
    canonicalPath: HOME_PATH,
    description,
    image: branding.hero ?? branding.logo,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: shop.name,
      url: relative(HOME_PATH),
      ...(branding.logo === null ? {} : { logo: branding.logo.url }),
      ...(description === null ? {} : { description }),
      ...(identity.supportEmail === undefined
        ? {}
        : {
            contactPoint: {
              "@type": "ContactPoint",
              contactType: "customer service",
              email: identity.supportEmail,
            },
          }),
      ...(socialLinks.length === 0 ? {} : { sameAs: socialLinks }),
    },
    robots: null,
    title: boundedTitle(tagline === null ? shop.name : `${shop.name} - ${tagline}`),
  };
}

function listingPage(
  shop: Shop,
  heading: string,
  path: string,
  links: readonly ProductLink[],
  description: string | null,
  image: PublicImage | null,
): SeoPage {
  const body = new BodyHtml(BODY_HTML_MAX);
  body.add(`<h1>${escapeHtml(heading)}</h1>`);
  if (description !== null) {
    body.add(`<p>${escapeHtml(description)}</p>`);
  }
  productListBody(body, links);
  const meta = truncateDescription(description);
  return {
    bodyHtml: body.toString(),
    canonicalPath: path,
    description: meta,
    image,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: heading,
      url: relative(path),
      ...(meta === null ? {} : { description: meta }),
      mainEntity: itemList(links),
    },
    robots: null,
    title: withShop(heading, shop),
  };
}

async function productPage(
  env: Env,
  db: D1Database,
  tenant: StorefrontTenant,
  shop: Shop,
  handle: string,
): Promise<SeoPage | null> {
  // THE public product as the storefront's own read finds and shapes it
  // (public-catalog.ts): by id, handle or the source system's sku rule, its
  // main image by the group rule, its canonical path by its handle.
  const product = await getPublicProductByRef(env, db, tenant, handle);
  if (product === null) {
    return null;
  }
  const image = product.image;
  const path = product.path;
  // The card's price (getCardPrice): the cheapest active variant priced above
  // zero, else the product's price. The highest by the same rule.
  const lowest = product.lowestPriceMinor;
  const from = product.isFromPrice;
  const priced = product.variants.map((variant) => variant.priceMinor).filter((price) => price > 0);
  const highest = priced.length === 0 ? lowest : Math.max(...priced);
  const locale = shop.storefront.locale;
  const description = truncateDescription(product.description ?? `${product.name} – ${shop.name}`);
  const category = product.category;
  const categoryLink = category === null ? null : categoryPath(category);

  const body = new BodyHtml(BODY_HTML_MAX);
  body.add("<article>");
  body.add(`<h1>${escapeHtml(product.name)}</h1>`);
  if (image !== null) {
    body.add(`<p>${imageTag(image, image.alt ?? product.name)}</p>`);
  }
  body.add(
    `<p>${escapeHtml(`${from ? "Från " : ""}${formatPrice(lowest, product.currency, locale)}`)}</p>`,
  );
  if (product.description !== null) {
    body.paragraphs(textParagraphs(product.description, BODY_TEXT_MAX));
  }
  if (category !== null && categoryLink !== null) {
    body.add(`<p>${link(categoryLink, category)}</p>`);
  }
  body.add("</article>");

  const offerAvailability = "https://schema.org/InStock";
  return {
    bodyHtml: body.toString(),
    canonicalPath: path,
    description,
    image,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      sku: product.sku,
      url: relative(path),
      ...(description === null ? {} : { description }),
      ...(image === null ? {} : { image: [image.url] }),
      ...(category === null ? {} : { category }),
      offers: from
        ? {
            "@type": "AggregateOffer",
            availability: offerAvailability,
            highPrice: schemaPrice(highest),
            lowPrice: schemaPrice(lowest),
            // The offers that were priced: the same variants the two prices
            // were taken from.
            offerCount: priced.length,
            priceCurrency: product.currency,
            url: relative(path),
          }
        : {
            "@type": "Offer",
            availability: offerAvailability,
            itemCondition: "https://schema.org/NewCondition",
            price: schemaPrice(lowest),
            priceCurrency: product.currency,
            url: relative(path),
          },
    },
    robots: null,
    title: withShop(product.name, shop),
  };
}

async function collectionPage(
  env: Env,
  db: D1Database,
  tenant: StorefrontTenant,
  shop: Shop,
  handle: string,
): Promise<SeoPage | null> {
  const tenantId = tenant.tenantId;
  const collection = await db
    .prepare(
      `SELECT collection_id, handle, title, description, image_object_id, type, rule_tag
       FROM collections
       WHERE tenant_id = ? AND handle = ? AND published = 1
       LIMIT 1`,
    )
    .bind(tenantId, handle)
    .first<CollectionRow>();
  if (collection === null) {
    return null;
  }
  let links: ProductLink[] = [];
  if (collection.type === "smart") {
    // A tag rule matches the tag by its address form, as the tag page does.
    const key = collection.rule_tag === null ? "" : slugify(collection.rule_tag);
    links = key === "" ? [] : await listTagProductLinks(db, tenant, key);
  } else {
    links = await listCollectionMemberLinks(db, tenant, collection.collection_id);
  }
  const images =
    collection.image_object_id === null
      ? new Map<string, PublicImage>()
      : await resolvePublicImages(env, db, tenantId, [collection.image_object_id], ["product_media"]);
  const image =
    collection.image_object_id === null ? null : (images.get(collection.image_object_id) ?? null);
  return listingPage(
    shop,
    collection.title,
    collectionPath(collection.handle),
    links,
    collection.description,
    image,
  );
}

async function contentPage(
  env: Env,
  db: D1Database,
  tenantId: string,
  shop: Shop,
  slug: string,
): Promise<SeoPage | null> {
  const page = await db
    .prepare(
      `SELECT slug, kind, title_json, content_json, summary_json, meta_title_json,
              meta_description_json, author, image_object_id, published_at
       FROM pages
       WHERE tenant_id = ? AND slug = ? AND status = 'published'
       LIMIT 1`,
    )
    .bind(tenantId, slug)
    .first<PageRow>();
  if (page === null) {
    return null;
  }
  const lang = shop.storefront.locale;
  const title = pickLanguage(page.title_json, lang) ?? page.slug;
  const metaTitle = pickLanguage(page.meta_title_json, lang);
  const summary = pickLanguage(page.summary_json, lang);
  const description = truncateDescription(pickLanguage(page.meta_description_json, lang) ?? summary);
  const content = pickLanguage(page.content_json, lang) ?? "";
  const images =
    page.image_object_id === null
      ? new Map<string, PublicImage>()
      : await resolvePublicImages(env, db, tenantId, [page.image_object_id], ["product_media"]);
  const image = page.image_object_id === null ? null : (images.get(page.image_object_id) ?? null);
  const path = pagePath(page.slug);
  const post = page.kind === "post";
  const publishedAt =
    typeof page.published_at === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(page.published_at)
      ? page.published_at
      : null;
  const author = typeof page.author === "string" && page.author.trim() !== "" ? page.author.trim() : null;

  const body = new BodyHtml(BODY_HTML_MAX);
  body.add("<article>");
  body.add(`<h1>${escapeHtml(title)}</h1>`);
  if (post && (publishedAt !== null || author !== null)) {
    const date =
      publishedAt === null
        ? ""
        : `<time datetime="${escapeHtml(publishedAt)}">${escapeHtml(publishedAt.slice(0, 10))}</time>`;
    body.add(`<p>${date}${date !== "" && author !== null ? " · " : ""}${author === null ? "" : escapeHtml(author)}</p>`);
  }
  if (image !== null) {
    body.add(`<p>${imageTag(image, title)}</p>`);
  }
  body.paragraphs(htmlToText(content, BODY_TEXT_MAX));
  body.add("</article>");

  return {
    bodyHtml: body.toString(),
    canonicalPath: path,
    description,
    image,
    jsonLd: post
      ? {
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: boundedTitle(title),
          url: relative(path),
          ...(description === null ? {} : { description }),
          ...(publishedAt === null ? {} : { datePublished: publishedAt }),
          ...(author === null ? {} : { author: { "@type": "Person", name: author } }),
          ...(image === null ? {} : { image: [image.url] }),
          publisher: { "@type": "Organization", name: shop.name },
        }
      : {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: boundedTitle(title),
          url: relative(path),
          ...(description === null ? {} : { description }),
        },
    robots: null,
    title: boundedTitle(metaTitle ?? title),
  };
}

async function legalPage(
  db: D1Database,
  tenantId: string,
  shop: Shop,
  key: PublicLegalKey,
  now: number,
): Promise<SeoPage | null> {
  const page = PUBLIC_LEGAL_PAGES.find((entry) => entry.key === key);
  if (page === undefined) {
    return null;
  }
  const legal = await legalPageTexts(db, tenantId, now);
  const text = key === "plattformsvillkor" ? null : (legal.texts.get(key) ?? null);
  if (key === "plattformsvillkor" ? legal.platformTermsAt === null : text === null) {
    return null;
  }
  const description = truncateDescription(`${page.title} – ${shop.name}.`);
  const body = new BodyHtml(BODY_HTML_MAX);
  body.add("<article>");
  body.add(`<h1>${escapeHtml(page.title)}</h1>`);
  if (text !== null) {
    body.paragraphs(htmlToText(text, BODY_TEXT_MAX));
  }
  body.add("</article>");
  return {
    bodyHtml: body.toString(),
    canonicalPath: page.path,
    description,
    image: null,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.title,
      url: relative(page.path),
      ...(description === null ? {} : { description }),
    },
    robots: null,
    title: withShop(page.title, shop),
  };
}

/**
 * THE answer of GET /v1/seo for `rawPath` (the path under the shop's root as
 * the visitor asked for it, percent-encoded or not). null = 404: the shop is
 * not public, the path is not a path, or it names no public page.
 *
 * A tenant marked `preview` (a valid grant, preview.ts) is read through the
 * preview's fragment and shop gate, and its page always says
 * `robots: "noindex"`: a page of a preview is never one to index.
 */
export async function resolveSeoAnswer(
  env: Env,
  db: D1Database,
  tenant: StorefrontTenant,
  rawPath: string,
  now: number,
): Promise<SeoAnswer | null> {
  const storefront = await getPublicStorefrontVersioned(env, db, tenant);
  if (storefront === null) {
    return null;
  }
  const normal = normalizeStorefrontPath(rawPath);
  if (normal === null) {
    return null;
  }

  const to = await findRedirect(db, tenant.tenantId, normal);
  if (to !== null) {
    return { redirect: { status: 301, to } };
  }

  const route = parseStorefrontRoute(normal);
  if (route === null) {
    return null;
  }
  const shop: Shop = { name: storefront.value.name, storefront: storefront.value };
  const tenantId = tenant.tenantId;

  let page: SeoPage | null = null;
  switch (route.kind) {
    case "home":
      page = homePage(shop);
      break;
    case "all_products":
      page = listingPage(
        shop,
        "Alla produkter",
        ALL_PRODUCTS_PATH,
        await listAllProductLinks(db, tenant),
        shop.storefront.identity.productsSubtitle ?? null,
        null,
      );
      break;
    case "product":
      page = await productPage(env, db, tenant, shop, route.handle);
      break;
    case "category": {
      const [name] = await publicCategoryNames(db, tenant, route.slug);
      const path = name === undefined ? null : categoryPath(name);
      page =
        name === undefined || path === null
          ? null
          : listingPage(shop, name, path, await listCategoryProductLinks(db, tenant, route.slug), null, null);
      break;
    }
    case "tag": {
      const [name] = await publicTagNames(db, tenant, route.slug);
      const path = name === undefined ? null : tagPath(name);
      page =
        name === undefined || path === null
          ? null
          : listingPage(shop, name, path, await listTagProductLinks(db, tenant, route.slug), null, null);
      break;
    }
    case "collection":
      page = await collectionPage(env, db, tenant, shop, route.handle);
      break;
    case "page":
      page = await contentPage(env, db, tenantId, shop, route.slug);
      break;
    case "legal":
      page = await legalPage(db, tenantId, shop, route.key, now);
      break;
  }
  if (page === null) {
    return null;
  }
  return { page: isPreview(tenant) ? { ...page, robots: "noindex" } : page };
}
