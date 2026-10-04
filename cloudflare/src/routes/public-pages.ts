import {
  listPublicPages,
  parsePublicPageListQuery,
  parsePublicPageQuery,
  readPublicPage,
} from "../content/pages";
import { decodeSegment, invalidRequestResponse, notFoundResponse } from "../lib/responses";
import { resolveStorefrontTenant } from "../storefront/preview";
import { versionedJsonResponse } from "../storefront/public-routes";

/**
 * CP4-C — the storefront's content pages and posts (D84, D88). The tenant is
 * the request's hostname, as on every public read; nothing is taken from the
 * browser. Only PUBLISHED pages of an ACTIVE, PUBLISHED shop answer.
 *
 *   GET /v1/pages?kind=page|post&lang&cursor&limit=1..100 (20)
 *       200 { pages: [{ slug, path, kind, title, summary, author, publishedAt,
 *                       image: PublicImage | null }], nextCursor: string | null }
 *       newest first by publication; `kind` absent = pages and posts together
 *       400 invalid_request   an unknown or repeated parameter, a bad kind,
 *                             limit or cursor
 *   GET /v1/pages/:slug?lang
 *       200 { page: { slug, path, kind, lang, title, content, summary, metaTitle,
 *                     metaDescription, author, publishedAt, updatedAt,
 *                     image: PublicImage | null } }
 *       400 invalid_request   a parameter other than one `lang`
 *
 *   `lang`: each text in the requested language when the page has it, else in
 *   the shop's default language, else in the page's first language; an
 *   absent, malformed or unknown `lang` reads as the default. `path` is
 *   relative to the shop's root ("/<slug>"). `lang` in the answer is the
 *   language the content is in.
 *
 *   404 { error: { code: "not_found", message: "Page not found" } } — an unknown
 *   host, a suspended or unpublished shop, a draft, an unknown slug.
 *
 * Every 200 carries `ETag: "<catalog_version>"` and answers `If-None-Match`
 * with a bodiless 304 (src/storefront/public-routes.ts versionedJsonResponse),
 * except a preview's: a valid grant (src/storefront/preview.ts) reads an
 * unpublished shop and answers no-store, no ETag, noindex.
 */

export const PUBLIC_PAGES_PATH = "/v1/pages";
export const PUBLIC_PAGE_ROUTE = "/v1/pages/:slug";

function pageNotFound(): Response {
  return notFoundResponse("Page not found");
}

export async function handlePublicPagesRoute(env: Env, request: Request): Promise<Response> {
  const query = parsePublicPageListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  const tenant = await resolveStorefrontTenant(env, request);
  const preview = tenant?.preview === true;
  const list = tenant === null ? null : await listPublicPages(env, env.DB, tenant.tenantId, query, preview);
  return tenant === null || list === null
    ? pageNotFound()
    : versionedJsonResponse(
        request,
        list.catalogVersion,
        { nextCursor: list.nextCursor, pages: list.pages },
        tenant,
      );
}

export async function handlePublicPageRoute(env: Env, request: Request, segment: string): Promise<Response> {
  const query = parsePublicPageQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  const slug = decodeSegment(segment);
  if (slug === null) {
    return pageNotFound();
  }
  const tenant = await resolveStorefrontTenant(env, request);
  const preview = tenant?.preview === true;
  const read =
    tenant === null ? null : await readPublicPage(env, env.DB, tenant.tenantId, slug, query.lang, preview);
  return tenant === null || read === null
    ? pageNotFound()
    : versionedJsonResponse(request, read.catalogVersion, { page: read.page }, tenant);
}
