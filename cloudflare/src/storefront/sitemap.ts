import {
  ELIGIBLE_PRODUCTS_FROM,
  PUBLIC_ELIGIBILITY_PREDICATE,
} from "../catalog/eligibility";
import { PUBLIC_LEGAL_PAGES } from "../routes/public-legal";
import type { TenantContext } from "../tenancy/resolve-tenant";
import {
  ALL_PRODUCTS_PATH,
  categoryPath,
  collectionPath,
  HOME_PATH,
  pagePath,
  productPath,
  tagPath,
} from "./addresses";
import { legalPageTexts } from "./seo";

/**
 * CP4-D — `GET /v1/sitemap?cursor=&limit=` → `{ entries: [{ path,
 * lastModified }], nextCursor }`: every public address of the shop, relative
 * to its root, at most 5 000 per answer. The web Worker writes the XML (and
 * robots.txt) and follows `nextCursor` (cloudflare/web/src/sitemap.ts).
 *
 * The addresses come in SECTIONS, in a fixed order; each section is walked by
 * a keyset (its own stable key, ascending), so the cursor is (section, last
 * key) and a walk never repeats or skips a row that stays public. A row that
 * gives no address (a product without a handle, a category that slugifies to
 * nothing) still advances the walk.
 *
 * Only what a visitor can reach: products through THE predicate, collections
 * and pages when published, categories and tags of public products, the legal
 * pages the shop has adopted, and the platform terms when a version is out.
 */

export interface SitemapEntry {
  lastModified: string | null;
  path: string;
}

export interface SitemapPage {
  entries: SitemapEntry[];
  nextCursor: string | null;
}

export const SITEMAP_PAGE_MAX = 5_000;
const CURSOR_MAX_LENGTH = 512;
/** Queries per answer; a walk that needs more continues on the next call. */
const QUERY_BUDGET = 24;

const SECTIONS = [
  "static",
  "products",
  "collections",
  "categories",
  "tags",
  "pages",
  "legal",
] as const;

type Section = (typeof SECTIONS)[number];

interface Row {
  entry: SitemapEntry | null;
  key: string;
}

export interface SitemapCursor {
  after: string;
  section: number;
}

function base64UrlEncode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeSitemapCursor(cursor: SitemapCursor): string {
  return `${cursor.section}.${base64UrlEncode(cursor.after)}`;
}

/** null = not a cursor this route wrote. */
export function decodeSitemapCursor(value: string): SitemapCursor | null {
  const match = /^([0-6])\.([A-Za-z0-9_-]*)$/.exec(value);
  if (value.length > CURSOR_MAX_LENGTH || match === null) {
    return null;
  }
  const [, section, encoded] = match;
  if (section === undefined || encoded === undefined) {
    return null;
  }
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return {
      after: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      section: Number(section),
    };
  } catch {
    return null;
  }
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function isoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return typeof value === "string" && ISO_TIME.test(value) ? value : null;
}

/** A section's rows after `after`, at most `limit`, ascending by key. */
async function sectionRows(
  section: Section,
  db: D1Database,
  tenantId: string,
  after: string,
  limit: number,
  now: number,
): Promise<Row[]> {
  switch (section) {
    case "static":
      return [HOME_PATH, ALL_PRODUCTS_PATH]
        .filter((path) => path > after)
        .slice(0, limit)
        .map((path) => ({ entry: { lastModified: null, path }, key: path }));

    case "products": {
      const rows = await db
        .prepare(
          `SELECT product.product_id AS product_id, product.handle AS handle,
                  MAX(product.updated_at, publication.updated_at) AS updated_at
           ${ELIGIBLE_PRODUCTS_FROM}
           WHERE publication.tenant_id = ? AND product.tenant_id = ?
             AND product.product_id > ?
             AND ${PUBLIC_ELIGIBILITY_PREDICATE}
           ORDER BY product.product_id
           LIMIT ?`,
        )
        .bind(tenantId, tenantId, after, limit)
        .all<{ handle: string | null; product_id: string; updated_at: number }>();
      return rows.results.map((row) => ({
        entry:
          typeof row.handle === "string" && row.handle.length > 0
            ? { lastModified: isoOrNull(row.updated_at), path: productPath(row.handle) }
            : null,
        key: row.product_id,
      }));
    }

    case "collections": {
      const rows = await db
        .prepare(
          `SELECT collection_id, handle, updated_at FROM collections
           WHERE tenant_id = ? AND published = 1 AND collection_id > ?
           ORDER BY collection_id
           LIMIT ?`,
        )
        .bind(tenantId, after, limit)
        .all<{ collection_id: string; handle: string; updated_at: unknown }>();
      return rows.results.map((row) => ({
        entry: { lastModified: isoOrNull(row.updated_at), path: collectionPath(row.handle) },
        key: row.collection_id,
      }));
    }

    case "categories": {
      const rows = await db
        .prepare(
          `SELECT DISTINCT product.category AS value
           ${ELIGIBLE_PRODUCTS_FROM}
           WHERE publication.tenant_id = ? AND product.tenant_id = ?
             AND product.category IS NOT NULL
             AND product.category > ?
             AND ${PUBLIC_ELIGIBILITY_PREDICATE}
           ORDER BY value
           LIMIT ?`,
        )
        .bind(tenantId, tenantId, after, limit)
        .all<{ value: string }>();
      return rows.results.map((row) => {
        const path = categoryPath(row.value);
        return { entry: path === null ? null : { lastModified: null, path }, key: row.value };
      });
    }

    case "tags": {
      const rows = await db
        .prepare(
          `SELECT DISTINCT tagged.tag AS value
           ${ELIGIBLE_PRODUCTS_FROM}
           INNER JOIN product_tags AS tagged
             ON tagged.product_id = product.product_id
            AND tagged.tenant_id = product.tenant_id
           WHERE publication.tenant_id = ? AND product.tenant_id = ?
             AND tagged.tag > ?
             AND ${PUBLIC_ELIGIBILITY_PREDICATE}
           ORDER BY value
           LIMIT ?`,
        )
        .bind(tenantId, tenantId, after, limit)
        .all<{ value: string }>();
      return rows.results.map((row) => {
        const path = tagPath(row.value);
        return { entry: path === null ? null : { lastModified: null, path }, key: row.value };
      });
    }

    case "pages": {
      const rows = await db
        .prepare(
          `SELECT page_id, slug, updated_at FROM pages
           WHERE tenant_id = ? AND status = 'published' AND page_id > ?
           ORDER BY page_id
           LIMIT ?`,
        )
        .bind(tenantId, after, limit)
        .all<{ page_id: string; slug: string; updated_at: unknown }>();
      return rows.results.map((row) => ({
        entry: { lastModified: isoOrNull(row.updated_at), path: pagePath(row.slug) },
        key: row.page_id,
      }));
    }

    case "legal": {
      const legal = await legalPageTexts(db, tenantId, now);
      return PUBLIC_LEGAL_PAGES.filter((page) => page.path > after)
        .filter((page) =>
          page.key === "plattformsvillkor" ? legal.platformTermsAt !== null : legal.texts.has(page.key),
        )
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .slice(0, limit)
        .map((page) => ({
          entry: {
            lastModified: isoOrNull(
              page.key === "plattformsvillkor" ? legal.platformTermsAt : legal.acceptedAt,
            ),
            path: page.path,
          },
          key: page.path,
        }));
    }
  }
}

/**
 * One answer of the sitemap, from `cursor` (null = the start). The caller has
 * checked that the shop is public; `limit` is 1–5 000.
 */
export async function buildSitemapPage(
  db: D1Database,
  tenant: TenantContext,
  cursor: SitemapCursor | null,
  limit: number,
  now: number,
): Promise<SitemapPage> {
  let section = cursor?.section ?? 0;
  let after = cursor?.after ?? "";
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  let queries = 0;

  while (section < SECTIONS.length && entries.length < limit && queries < QUERY_BUDGET) {
    const wanted = limit - entries.length;
    const name = SECTIONS[section] as Section;
    const rows = await sectionRows(name, db, tenant.tenantId, after, wanted, now);
    queries += 1;
    for (const row of rows) {
      after = row.key;
      // Two categories (or tags) that slugify alike share one address.
      if (row.entry !== null && !seen.has(row.entry.path)) {
        seen.add(row.entry.path);
        entries.push(row.entry);
      }
    }
    if (rows.length < wanted) {
      section += 1;
      after = "";
    }
  }

  return {
    entries,
    nextCursor: section < SECTIONS.length ? encodeSitemapCursor({ after, section }) : null,
  };
}
