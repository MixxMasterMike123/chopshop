import { jsonResponse } from "../lib/http";
import { invalidRequestResponse, notFoundResponse } from "../lib/responses";
import { isPublicShop } from "../storefront/public-storefront";
import { resolveSeoAnswer } from "../storefront/seo";
import {
  buildSitemapPage,
  decodeSitemapCursor,
  SITEMAP_PAGE_MAX,
} from "../storefront/sitemap";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP4-D — the two reads the web Worker makes for search engines (D88). The
 * tenant is the request's hostname, as on every storefront route; the web
 * Worker reaches them through `Internal.fetchForShop`, never on behalf of a
 * browser (neither is on its allowlist of browser routes).
 *
 *   GET /v1/seo?path=<path under the shop's root>
 *       200 { redirect: { to, status: 301 } }       a forward (to = encoded path)
 *       200 { page: { title, description, canonicalPath, image, robots,
 *                     jsonLd, bodyHtml } }           a public page
 *       400 invalid_request                           no `path`, two of them,
 *                                                     or another parameter
 *       404 not_found                                 not a public shop, or no
 *                                                     public page at that path
 *
 *   GET /v1/sitemap?cursor=&limit=
 *       200 { entries: [{ path, lastModified }], nextCursor }
 *       400 invalid_request                           a cursor this route did
 *                                                     not write, a limit outside
 *                                                     1–5 000, another parameter
 *       404 not_found                                 not a public shop
 *
 * Both answer `Cache-Control: no-store` and no ETag: the SEO answer is built
 * from more than the catalogue (forwards, adopted legal texts, the platform's
 * terms), and the web Worker, their only caller, never revalidates. It caches
 * the sitemap's XML itself for an hour.
 */

export const SEO_PATH = "/v1/seo";
export const SITEMAP_PATH = "/v1/sitemap";

/** The one value of `name`, or null when it is absent or repeated. */
function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function onlyParams(params: URLSearchParams, allowed: readonly string[]): boolean {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      return false;
    }
  }
  return true;
}

export async function handlePublicSeoRequest(env: Env, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const path = singleParam(params, "path");
  if (path === null || !onlyParams(params, ["path"])) {
    return invalidRequestResponse();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  const answer =
    tenant === null ? null : await resolveSeoAnswer(env, env.DB, tenant, path, Date.now());
  return answer === null ? notFoundResponse("Page not found") : jsonResponse(answer);
}

export async function handlePublicSitemapRequest(env: Env, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (
    !onlyParams(params, ["cursor", "limit"]) ||
    params.getAll("cursor").length > 1 ||
    params.getAll("limit").length > 1
  ) {
    return invalidRequestResponse();
  }
  const rawCursor = params.get("cursor");
  const cursor = rawCursor === null ? null : decodeSitemapCursor(rawCursor);
  if (rawCursor !== null && cursor === null) {
    return invalidRequestResponse();
  }
  const rawLimit = params.get("limit");
  const limit =
    rawLimit === null
      ? SITEMAP_PAGE_MAX
      : /^[1-9][0-9]{0,3}$/.test(rawLimit)
        ? Number(rawLimit)
        : 0;
  if (limit < 1 || limit > SITEMAP_PAGE_MAX) {
    return invalidRequestResponse();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  // The same rule as every public read: an active, published shop only.
  if (tenant === null || !(await isPublicShop(env.DB, tenant.tenantId))) {
    return notFoundResponse("Sitemap not found");
  }
  return jsonResponse(await buildSitemapPage(env.DB, tenant, cursor, limit, Date.now()));
}
