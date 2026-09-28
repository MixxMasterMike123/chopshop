import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import type { ParsedPageInput, PageWriteResult } from "../content/pages";
import {
  createPage,
  deletePage,
  getAdminPage,
  listAdminPages,
  PAGE_BODY_MAX_BYTES,
  PAGE_ID_PATTERN,
  parseAdminPageListQuery,
  parsePageInput,
  updatePage,
} from "../content/pages";
import { readJsonBodyWithin } from "../legal/legal-pages";
import { jsonResponse } from "../lib/http";
import { decodeSegment, invalidRequestResponse, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * CP4-C — the shop admin's pages and posts (migrations/0042 `pages`):
 *
 *   GET    /v1/admin/pages?kind=page|post&status=draft|published&cursor&limit=1..100 (50)
 *          200 { pages: [{ pageId, slug, path, kind, status, title: { <lang>: text },
 *                          publishedAt, createdAt, updatedAt }], nextCursor: string | null }
 *          newest first by creation; the cursor is the answer's `nextCursor`
 *   POST   /v1/admin/pages   { slug, title, content, kind?, status?, summary?, metaTitle?,
 *                              metaDescription?, author?, imageObjectId?, publishedAt? }
 *          201 { page }
 *   GET    /v1/admin/pages/:pageId      200 { page }
 *   PATCH  /v1/admin/pages/:pageId      any non-empty subset of the POST fields
 *          200 { page }
 *   DELETE /v1/admin/pages/:pageId      204
 *
 *   page = { pageId, slug, path, kind, status, title, content, summary, metaTitle,
 *            metaDescription, author, imageObjectId, image: PublicImage | null,
 *            publishedAt, createdAt, updatedAt, createdBy, updatedBy }
 *
 *   400 invalid_request                      shape, grammar, lengths, a published page
 *                                            without a date
 *   400 { error: { code: "slug_reserved" } } the slug is a first segment the
 *                                            storefront owns, `legal` or a legal key
 *   400 { error: { code: "content_refused", reason, language } }
 *                                            the HTML holds what html-refusal.ts refuses
 *   400 { error: { code: "image_not_referencable" } }
 *                                            not an active public product image of
 *                                            this shop
 *   409 { error: { code: "slug_taken" } }    another page of this shop has the slug
 *   413 payload_too_large                    body over 1 MiB, content over 256 KiB of
 *                                            stored JSON, a text over its cap
 *   404 the opaque answer: no session, no membership or acting-as grant on the
 *       named shop, a cross-origin or origin-less write, a malformed or unknown
 *       page id, another shop's page
 *
 * Tenant = `X-Shop-Id` checked against the session's live memberships, or a
 * platform user's live acting-as grant on it (admitted, as for the store
 * settings: content an operator may fix for the seller; the audit row carries
 * the grant id). Every write is audited in its own batch.
 */

export const ADMIN_PAGES_PATH = "/v1/admin/pages";
export const ADMIN_PAGE_ROUTE = "/v1/admin/pages/:pageId";

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message, ...extra } }, status);
}

function payloadTooLargeResponse(): Response {
  return errorResponse(413, "payload_too_large", "The page exceeds the maximum allowed size");
}

/** The answer to a body the parser refused. */
function refusedInputResponse(parsed: Exclude<ParsedPageInput, { status: "ok" }>): Response {
  switch (parsed.status) {
    case "invalid":
      return invalidRequestResponse();
    case "reserved_slug":
      return errorResponse(400, "slug_reserved", "The slug is reserved by the storefront");
    case "content_refused":
      return errorResponse(400, "content_refused", "The content holds markup this route does not accept", {
        language: parsed.language,
        reason: parsed.reason,
      });
    case "too_large":
      return payloadTooLargeResponse();
  }
}

function writeResponse(result: PageWriteResult, created: boolean): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse({ page: result.page }, created ? 201 : 200);
    case "image_not_referencable":
      return errorResponse(400, "image_not_referencable", "The image is not a public product image of this shop");
    case "invalid":
      return invalidRequestResponse();
    case "not_found":
      return routeNotFoundResponse();
    case "slug_taken":
      return errorResponse(409, "slug_taken", "Another page of this shop has the slug");
  }
}

async function readPageBody(request: Request, mode: "create" | "update"): Promise<ParsedPageInput> {
  const body = await readJsonBodyWithin(request, PAGE_BODY_MAX_BYTES);
  return body.status === "too_large" ? { status: "too_large" } : parsePageInput(body.value, mode);
}

export async function handleAdminPagesRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || (request.method !== "GET" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const query = parseAdminPageListQuery(new URL(request.url));
    return query === null
      ? invalidRequestResponse()
      : jsonResponse(await listAdminPages(env.DB, principal.tenantId, query));
  }

  const parsed = await readPageBody(request, "create");
  if (parsed.status !== "ok") {
    return refusedInputResponse(parsed);
  }
  return writeResponse(await createPage(env, env.DB, principal, parsed.input, Date.now()), true);
}

export async function handleAdminPageRoute(env: Env, request: Request, segment: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "DELETE") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || (request.method !== "GET" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }
  const pageId = decodeSegment(segment);
  if (pageId === null || !PAGE_ID_PATTERN.test(pageId)) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const page = await getAdminPage(env, env.DB, principal.tenantId, pageId);
    return page === null ? routeNotFoundResponse() : jsonResponse({ page });
  }

  if (request.method === "DELETE") {
    const deleted = await deletePage(env.DB, principal, pageId, Date.now());
    return deleted.status === "ok" ? new Response(null, { status: 204 }) : routeNotFoundResponse();
  }

  const parsed = await readPageBody(request, "update");
  if (parsed.status !== "ok") {
    return refusedInputResponse(parsed);
  }
  return writeResponse(await updatePage(env, env.DB, principal, pageId, parsed.input, Date.now()), false);
}
