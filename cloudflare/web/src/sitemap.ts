/**
 * `<root>/sitemap.xml` from `GET /v1/sitemap`, and `/robots.txt` (brief E
 * rule 4). The API answers paths relative to the shop's root; the addresses in
 * the XML are made here, each through the same root check as every other
 * address this Worker writes.
 */

export interface SitemapEntry {
  lastModified: string | null;
  path: string;
}

export interface SitemapPage {
  entries: SitemapEntry[];
  nextCursor: string | null;
}

/** One answer holds at most 5 000 (brief D); a sitemap file at most 50 000. */
export const MAX_SITEMAP_PAGES = 10;
export const SITEMAP_DEADLINE_MS = 5_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const MAX_CURSOR = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSitemapPage(body: unknown): SitemapPage | null {
  if (!isRecord(body) || !Array.isArray(body.entries)) {
    return null;
  }

  const entries: SitemapEntry[] = [];
  for (const raw of body.entries) {
    if (isRecord(raw) && typeof raw.path === "string") {
      entries.push({
        lastModified:
          typeof raw.lastModified === "string" && ISO_DATE.test(raw.lastModified)
            ? raw.lastModified
            : null,
        path: raw.path,
      });
    }
  }

  const cursor = body.nextCursor;
  return {
    entries,
    nextCursor:
      typeof cursor === "string" && cursor.length > 0 && cursor.length <= MAX_CURSOR
        ? cursor
        : null,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * `resolve` turns a relative path into an absolute address, or null when the
 * path would leave the shop's root; such an entry is left out.
 */
export function buildSitemapXml(
  entries: readonly SitemapEntry[],
  resolve: (relative: string) => string | null,
): string {
  const urls: string[] = [];
  for (const entry of entries) {
    const loc = resolve(entry.path);
    if (loc === null) {
      continue;
    }
    urls.push(
      `<url><loc>${escapeXml(loc)}</loc>${
        entry.lastModified === null ? "" : `<lastmod>${escapeXml(entry.lastModified)}</lastmod>`
      }</url>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`
  );
}

/**
 * On a shop's own domain the sitemap is named. On the shared host there is no
 * single sitemap: each shop's is at `/<shop>/sitemap.xml`, and this Worker has
 * no list of shops to name them from.
 */
export function buildRobotsTxt(sitemapUrl: string | null): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /_api/",
    ...(sitemapUrl === null ? [] : [`Sitemap: ${sitemapUrl}`]),
    "",
  ].join("\n");
}
