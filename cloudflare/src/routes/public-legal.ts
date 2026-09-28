import { publicTenantStatement } from "../content/pages";
import { LEGAL_PAGE_KEYS } from "../legal/legal-pages";
import { readTermsStatus, readTermsText } from "../legal/platform-terms";
import { decodeSegment, notFoundResponse } from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP4-C — the legal pages a visitor reads (D79): exactly the text the seller
 * ADOPTED, as adopted, and nothing a content page can edit.
 *
 *   GET /v1/legal
 *       200 { pages: [{ key, path, title }] }   the pages this shop has, in the
 *           footer's order: the three of the latest adoption that hold text,
 *           then the platform's terms while their current version has its
 *           text archived
 *   GET /v1/legal/:key          key = kopvillkor | angerratt | integritetspolicy,
 *                               or the last segment of the page's address
 *       200 { page: { key, path, title, html, adoptedAt } }
 *           `html` = that page of the shop's LATEST legal-pages adoption
 *           (0037 legal_acceptances.texts_json, type legalPages), verbatim;
 *           `adoptedAt` = that adoption's accepted_at. No adoption, or an
 *           adoption without a text for the key → 404.
 *   GET /v1/legal/plattformsvillkor
 *       200 { page: { key, path, title, version, publishedAt, text } }
 *           the CURRENT platform-terms version (the latest published at or
 *           before now) and its archived text, verbatim — the bytes whose
 *           SHA-256 the version holds (re-hashed on the way out by
 *           readTermsText; a mismatch is a fault, never served). No current
 *           version, no archived text or no private bucket → 404.
 *
 *   `path` is today's storefront address, relative to the shop's root.
 *
 *   404 { error: { code: "not_found", message: "Legal page not found" } } — an
 *   unknown host, a suspended or unpublished shop, an unknown key.
 *
 * CACHING. Every 200 carries an ETag and answers `If-None-Match` with a
 * bodiless 304, `Cache-Control: no-cache`, as every public read. A shop page's
 * ETag is `"<catalog_version>"`: a new adoption bumps it (0042's trigger on
 * legal_acceptances). The platform terms change without a write — a version
 * published for later becomes current when its time comes — so the ETag of
 * the terms and of the list carries the current version too:
 * `"<catalog_version>.<version>"`, and for the list `.none` when no current
 * version has its text. The comparison is made before the archived text is
 * read, so a 304 costs no bucket read.
 */

export const PUBLIC_LEGAL_PATH = "/v1/legal";
export const PUBLIC_LEGAL_ROUTE = "/v1/legal/:key";

export const PLATFORM_TERMS_KEY = "plattformsvillkor";

type ShopLegalKey = (typeof LEGAL_PAGE_KEYS)[number];
export type PublicLegalKey = ShopLegalKey | typeof PLATFORM_TERMS_KEY;

/**
 * The four legal pages, in the footer's order, at today's addresses
 * (src/config/legalTemplates.js LEGAL_SLUGS, PLATFORM_TERMS_SLUG) with
 * today's titles (LEGAL_PAGES, PLATFORM_TERMS_TITLE).
 */
export const PUBLIC_LEGAL_PAGES: ReadonlyArray<{ key: PublicLegalKey; path: string; title: string }> = [
  { key: "kopvillkor", path: "/legal/kopvillkor", title: "Köpvillkor" },
  { key: "angerratt", path: "/legal/angerratt-och-returer", title: "Ångerrätt & returer" },
  { key: "integritetspolicy", path: "/legal/integritetspolicy", title: "Integritetspolicy" },
  { key: PLATFORM_TERMS_KEY, path: "/legal/plattformsvillkor", title: "Plattformsvillkor" },
];

export interface PublicShopLegalPage {
  adoptedAt: string;
  html: string;
  key: ShopLegalKey;
  path: string;
  title: string;
}

export interface PublicPlatformTermsPage {
  key: typeof PLATFORM_TERMS_KEY;
  path: string;
  publishedAt: string;
  text: string;
  title: string;
  version: string;
}

function isShopLegalKey(key: string): key is ShopLegalKey {
  return (LEGAL_PAGE_KEYS as readonly string[]).includes(key);
}

function legalEntry(key: PublicLegalKey): { key: PublicLegalKey; path: string; title: string } {
  const entry = PUBLIC_LEGAL_PAGES.find((page) => page.key === key);
  if (entry === undefined) {
    throw new Error(`no legal page entry for ${key}`);
  }
  return entry;
}

// The JSON path of one page inside a snapshot. The key is one of the three
// fixed keys, never a request's text.
function snapshotPath(key: ShopLegalKey): string {
  return `$.${key}`;
}

const LATEST_ADOPTION_ORDER = "ORDER BY accepted_at DESC, acceptance_id DESC LIMIT 1";

async function publicCatalogVersion(db: D1Database, tenantId: string): Promise<number | null> {
  const row = await publicTenantStatement(db, tenantId).first<{ catalog_version: number }>();
  return row?.catalog_version ?? null;
}

/**
 * The platform terms a visitor can read: the current version when its text is
 * archived, else null. `readTermsStatus` is THE definition of "current".
 */
async function currentArchivedTerms(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<{ publishedAt: string; version: string } | null> {
  const status = await readTermsStatus(db, tenantId, now);
  if (status.currentVersion === null || status.currentPublishedAt === null) {
    return null;
  }
  const archived = await db
    .prepare("SELECT 1 AS one FROM platform_terms_texts WHERE version = ? LIMIT 1")
    .bind(status.currentVersion)
    .first();
  return archived === null ? null : { publishedAt: status.currentPublishedAt, version: status.currentVersion };
}

// ── the ETag answer (one comparison, as src/storefront/public-routes.ts) ────

/** RFC 9110 §13.1.2: a list of entity tags, or `*`; weak comparison. */
function matchesIfNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) {
    return false;
  }
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

/**
 * 304 when the client holds `etag`; otherwise the body `build` makes (built
 * only then) or, when it makes none, the 404.
 */
async function etagResponse(
  request: Request,
  etag: string,
  build: () => Promise<unknown>,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (matchesIfNoneMatch(request, etag)) {
    return new Response(null, { headers, status: 304 });
  }
  const body = await build();
  if (body === null) {
    return legalNotFound();
  }
  return Response.json(body, {
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    status: 200,
  });
}

function legalNotFound(): Response {
  return notFoundResponse("Legal page not found");
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * One page of the shop's LATEST legal-pages adoption, read with the shop's
 * catalog_version in one batch (one transaction). Only that page's text is
 * read out of the snapshot. Null when the shop is not public, has adopted
 * nothing, or its latest adoption holds no text for the key.
 */
export async function readPublicShopLegalPage(
  db: D1Database,
  tenantId: string,
  key: ShopLegalKey,
): Promise<{ catalogVersion: number; page: PublicShopLegalPage } | null> {
  const [tenantResult, adoptionResult] = await db.batch<
    { catalog_version: number } | { accepted_at: string; html: unknown; html_type: string | null }
  >([
    publicTenantStatement(db, tenantId),
    db
      .prepare(
        `SELECT accepted_at, json_extract(texts_json, ?1) AS html, json_type(texts_json, ?1) AS html_type
         FROM legal_acceptances
         WHERE tenant_id = ?2 AND type = 'legalPages'
         ${LATEST_ADOPTION_ORDER}`,
      )
      .bind(snapshotPath(key), tenantId),
  ]);
  const tenant = tenantResult?.results[0] as { catalog_version: number } | undefined;
  const adoption = adoptionResult?.results[0] as
    | { accepted_at: string; html: unknown; html_type: string | null }
    | undefined;
  if (
    tenant === undefined ||
    adoption === undefined ||
    adoption.html_type !== "text" ||
    typeof adoption.html !== "string" ||
    adoption.html.length === 0
  ) {
    return null;
  }
  const entry = legalEntry(key);
  return {
    catalogVersion: tenant.catalog_version,
    page: { adoptedAt: adoption.accepted_at, html: adoption.html, key, path: entry.path, title: entry.title },
  };
}

/**
 * The shop's legal pages as the list answers them, and the ETag of that list.
 * Null when the shop is not public.
 */
export async function listPublicLegalPages(
  db: D1Database,
  tenantId: string,
  now: number,
): Promise<{ etag: string; pages: Array<{ key: PublicLegalKey; path: string; title: string }> } | null> {
  const columns = LEGAL_PAGE_KEYS.map(
    (key, index) =>
      `(json_type(texts_json, ?${index + 2}) = 'text'
        AND length(json_extract(texts_json, ?${index + 2})) > 0) AS has_${index}`,
  ).join(", ");
  const [tenantResult, adoptionResult] = await db.batch<{ catalog_version: number } | Record<string, number>>([
    publicTenantStatement(db, tenantId),
    db
      .prepare(
        `SELECT ${columns}
         FROM legal_acceptances
         WHERE tenant_id = ?1 AND type = 'legalPages'
         ${LATEST_ADOPTION_ORDER}`,
      )
      .bind(tenantId, ...LEGAL_PAGE_KEYS.map(snapshotPath)),
  ]);
  const tenant = tenantResult?.results[0] as { catalog_version: number } | undefined;
  if (tenant === undefined) {
    return null;
  }
  const adoption = adoptionResult?.results[0] as Record<string, number | null> | undefined;
  const terms = await currentArchivedTerms(db, tenantId, now);

  const present = new Set<PublicLegalKey>(
    LEGAL_PAGE_KEYS.filter((_key, index) => adoption?.[`has_${index}`] === 1),
  );
  if (terms !== null) {
    present.add(PLATFORM_TERMS_KEY);
  }
  return {
    etag: `"${tenant.catalog_version}.${terms?.version ?? "none"}"`,
    pages: PUBLIC_LEGAL_PAGES.filter((entry) => present.has(entry.key)),
  };
}

// ── routes ──────────────────────────────────────────────────────────────────

export async function handlePublicLegalPagesRoute(env: Env, request: Request): Promise<Response> {
  const tenant = await resolveRequestTenant(env.DB, request);
  const list = tenant === null ? null : await listPublicLegalPages(env.DB, tenant.tenantId, Date.now());
  if (list === null) {
    return legalNotFound();
  }
  return etagResponse(request, list.etag, async () => ({ pages: list.pages }));
}

export async function handlePublicLegalPageRoute(env: Env, request: Request, segment: string): Promise<Response> {
  const named = decodeSegment(segment);
  // A page is named by its key or by the last segment of its address
  // (`angerratt-och-returer`), which is what the storefront's router holds.
  const key =
    named === null
      ? null
      : (PUBLIC_LEGAL_PAGES.find(
          (page) => page.key === named || page.path === `/legal/${named}`,
        )?.key ?? null);
  if (key === null) {
    return legalNotFound();
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return legalNotFound();
  }

  if (isShopLegalKey(key)) {
    const read = await readPublicShopLegalPage(env.DB, tenant.tenantId, key);
    return read === null
      ? legalNotFound()
      : etagResponse(request, `"${read.catalogVersion}"`, async () => ({ page: read.page }));
  }

  // The platform's own terms: the same text for every shop, served only
  // under the host of a shop that is public.
  const bucket = env.PRIVATE_BUCKET;
  const catalogVersion = await publicCatalogVersion(env.DB, tenant.tenantId);
  if (catalogVersion === null || bucket === undefined) {
    return legalNotFound();
  }
  const terms = await currentArchivedTerms(env.DB, tenant.tenantId, Date.now());
  if (terms === null) {
    return legalNotFound();
  }
  return etagResponse(request, `"${catalogVersion}.${terms.version}"`, async () => {
    const read = await readTermsText(env.DB, bucket, terms.version);
    if (read.status !== "ok" || read.text === null) {
      return null;
    }
    const entry = legalEntry(PLATFORM_TERMS_KEY);
    const page: PublicPlatformTermsPage = {
      key: PLATFORM_TERMS_KEY,
      path: entry.path,
      publishedAt: read.publishedAt,
      text: read.text,
      title: entry.title,
      version: read.version,
    };
    return { page };
  });
}
