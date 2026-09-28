import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  decodeRedirectCursor,
  deleteRedirects,
  listRedirects,
  parseRedirectsDelete,
  parseRedirectsPut,
  putRedirects,
  type RedirectProblem,
  REDIRECTS_PAGE_DEFAULT,
  REDIRECTS_PER_CALL_MAX,
} from "../storefront/redirects";

/**
 * CP4-D — a shop's permanent forwards (D88), for the shop's own admin and the
 * importer (the admin page is CP5):
 *
 *   GET    /v1/admin/redirects?cursor=&limit=
 *          200 { redirects: [{ fromPath, toPath, createdAt, createdBy }], nextCursor }
 *              ordered by fromPath; limit 1–500 (default 100)
 *          400 invalid_request                 a bad cursor or limit, another parameter
 *   PUT    /v1/admin/redirects  { redirects: [{ fromPath, toPath }] }   1–500
 *          200 { redirects: [...] }            each written in the normal form
 *          400 invalid_request                 the shape
 *          400 refused_redirects { problems: [{ index, reason }] }
 *              reason: invalid_path | reserved_path | same_path | duplicate | chain
 *          409 conflict                        a concurrent write made it a chain
 *   DELETE /v1/admin/redirects  { fromPaths: [...] }                    1–500
 *          204                                 unknown paths are no-ops
 *          400 invalid_request
 *
 *   404 (opaque) for everyone but the shop's admin (or a platform user with a
 *   live acting-as grant on it), for another method, and for a cross-origin
 *   PUT or DELETE — checked before the body is read.
 *
 * Paths are relative to the shop's root and stored in ONE normal form
 * (src/storefront/redirects.ts normalizeStorefrontPath); a target never leaves
 * the shop's root, and no forward ever points at another forwarded path.
 */

export const ADMIN_REDIRECTS_PATH = "/v1/admin/redirects";

function refusedResponse(problems: readonly RedirectProblem[]): Response {
  return jsonResponse(
    {
      error: {
        code: "refused_redirects",
        message: "Some forwards cannot be written",
        problems,
      },
    },
    400,
  );
}

export async function handleAdminRedirectsRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || (request.method !== "GET" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (key !== "cursor" && key !== "limit") {
        return invalidRequestResponse();
      }
    }
    if (params.getAll("cursor").length > 1 || params.getAll("limit").length > 1) {
      return invalidRequestResponse();
    }
    const rawCursor = params.get("cursor");
    const after = rawCursor === null ? null : decodeRedirectCursor(rawCursor);
    if (rawCursor !== null && after === null) {
      return invalidRequestResponse();
    }
    const rawLimit = params.get("limit");
    const limit =
      rawLimit === null
        ? REDIRECTS_PAGE_DEFAULT
        : /^[1-9][0-9]{0,2}$/.test(rawLimit)
          ? Number(rawLimit)
          : 0;
    if (limit < 1 || limit > REDIRECTS_PER_CALL_MAX) {
      return invalidRequestResponse();
    }
    return jsonResponse(await listRedirects(env.DB, principal.tenantId, after, limit));
  }

  const body = await readJsonBody(request);

  if (request.method === "DELETE") {
    const fromPaths = parseRedirectsDelete(body);
    if (fromPaths === null) {
      return invalidRequestResponse();
    }
    await deleteRedirects(env.DB, principal, fromPaths, Date.now());
    return new Response(null, { headers: { "Cache-Control": "no-store" }, status: 204 });
  }

  const parsed = parseRedirectsPut(body);
  if (parsed.status === "invalid") {
    return invalidRequestResponse();
  }
  if (parsed.status === "refused") {
    return refusedResponse(parsed.problems);
  }
  const result = await putRedirects(env.DB, principal, parsed.entries, Date.now());
  if (result.status === "refused") {
    return refusedResponse(result.problems);
  }
  if (result.status === "conflict") {
    return jsonResponse(
      { error: { code: "conflict", message: "The forwards changed meanwhile; read them and try again" } },
      409,
    );
  }
  return jsonResponse({ redirects: result.redirects });
}
