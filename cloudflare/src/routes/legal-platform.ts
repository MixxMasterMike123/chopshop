import type { PlatformPrincipal } from "../auth/live-authorization";
import { authorizePlatformRequest, SHOP_ID_HEADER } from "../auth/request-authorization";
import { LEGAL_BODY_MAX_BYTES, readJsonBodyWithin } from "../legal/legal-pages";
import {
  attachTermsText,
  listTermsVersions,
  parseAttachTermsTextInput,
  parsePublishTermsInput,
  publishTermsVersion,
  readTermsText,
  TERMS_VERSION_PATTERN,
} from "../legal/platform-terms";
import { jsonResponse } from "../lib/http";
import { decodeSegment, invalidRequestResponse, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The platform's terms-version surface (CP3-E, migrations/0037). Platform
 * session only; the writes are same-origin and audited.
 *
 *   GET  /v1/platform/legal/terms-versions
 *        200 { versions: [{ version, publishedAt, sha256, textArchived, current }] }
 *            newest first (published_at, then label)
 *
 *   POST /v1/platform/legal/terms-versions   { version, text, publishedAt? }
 *        201 { version: { version, publishedAt, sha256, textArchived: true, current } }
 *            sha256 = SHA-256 of the text's UTF-8 bytes, computed here; the text is archived
 *            in the PRIVATE bucket first, then version + text row + audit in one batch.
 *            publishedAt (ISO, ms, UTC) defaults to now; later = scheduled.
 *        409 terms_version_exists · 409 terms_version_not_latest (+ latestPublishedAt)
 *        400 invalid_request (incl. a publishedAt in the past) · 413 payload_too_large
 *
 *   GET  /v1/platform/legal/terms-versions/:version/text
 *        200 { version, publishedAt, sha256, textArchived, text }   text null when none archived
 *
 *   PUT  /v1/platform/legal/terms-versions/:version/text   { text }
 *        201 { version: { … textArchived: true } }   archived now (the 0031 seed has no text)
 *        200 { version: … }                           already archived (the same bytes, by hash)
 *        409 terms_text_hash_mismatch (+ expectedSha256, suppliedSha256)
 *        400 invalid_request · 413 payload_too_large
 *
 *   404  no session, a tenant-admin session, a request that names a shop
 *        (`X-Shop-Id`, i.e. a platform user acting as a shop), a cross-origin
 *        write, an unknown version, and a worker without its private bucket.
 *
 * A request made IN A SHOP'S CONTEXT is never a platform request: any
 * `X-Shop-Id` header is refused before the session is read, so a platform
 * user working inside a shop under acting-as cannot reach these routes from
 * that context.
 */

export const PLATFORM_TERMS_VERSIONS_PATH = "/v1/platform/legal/terms-versions";
export const PLATFORM_TERMS_TEXT_ROUTE = "/v1/platform/legal/terms-versions/:version/text";

async function authorizePlatformLegal(
  env: Env,
  request: Request,
  write: boolean,
): Promise<PlatformPrincipal | null> {
  if (request.headers.has(SHOP_ID_HEADER) || (write && !isSameOriginRequest(request))) {
    return null;
  }
  return authorizePlatformRequest(env, request);
}

function payloadTooLargeResponse(): Response {
  return jsonResponse(
    { error: { code: "payload_too_large", message: "The text exceeds the maximum allowed size" } },
    413,
  );
}

function conflictResponse(code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ ...extra, error: { code, message } }, 409);
}

export async function handlePlatformTermsVersionsRoute(env: Env, request: Request): Promise<Response> {
  const write = request.method === "POST";
  const principal = await authorizePlatformLegal(env, request, write);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();

  if (!write) {
    return jsonResponse({ versions: await listTermsVersions(env.DB, now) });
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return routeNotFoundResponse();
  }
  const body = await readJsonBodyWithin(request, LEGAL_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const parsed = parsePublishTermsInput(body.value);
  if (parsed.status === "too_large") {
    return payloadTooLargeResponse();
  }
  if (parsed.status !== "ok") {
    return invalidRequestResponse();
  }

  const result = await publishTermsVersion(env.DB, bucket, principal, parsed.input, now);
  switch (result.status) {
    case "published":
      return jsonResponse({ version: result.version }, 201);
    case "version_exists":
      return conflictResponse("terms_version_exists", "A terms version with this label exists");
    case "not_after_latest":
      return conflictResponse(
        "terms_version_not_latest",
        "A new terms version must be published after the latest existing version",
        { latestPublishedAt: result.latestPublishedAt },
      );
    default:
      return invalidRequestResponse();
  }
}

/** `segment` is the RAW path segment; decoded once here (see ACTING_AS_ROUTE). */
export async function handlePlatformTermsTextRoute(
  env: Env,
  request: Request,
  segment: string,
): Promise<Response> {
  const write = request.method === "PUT";
  const principal = await authorizePlatformLegal(env, request, write);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const version = decodeSegment(segment);
  const bucket = env.PRIVATE_BUCKET;
  if (version === null || !TERMS_VERSION_PATTERN.test(version) || bucket === undefined) {
    return routeNotFoundResponse();
  }

  if (!write) {
    const read = await readTermsText(env.DB, bucket, version);
    if (read.status !== "ok") {
      return routeNotFoundResponse();
    }
    return jsonResponse({
      publishedAt: read.publishedAt,
      sha256: read.sha256,
      text: read.text,
      textArchived: read.text !== null,
      version: read.version,
    });
  }

  const body = await readJsonBodyWithin(request, LEGAL_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const parsed = parseAttachTermsTextInput(body.value);
  if (parsed.status === "too_large") {
    return payloadTooLargeResponse();
  }
  if (parsed.status !== "ok") {
    return invalidRequestResponse();
  }

  const result = await attachTermsText(env.DB, bucket, principal, version, parsed.input.text, Date.now());
  switch (result.status) {
    case "archived":
      return jsonResponse({ version: result.version }, 201);
    case "already_archived":
      return jsonResponse({ version: result.version }, 200);
    case "hash_mismatch":
      return conflictResponse(
        "terms_text_hash_mismatch",
        "The text does not hash to this version's stored SHA-256",
        { expectedSha256: result.expectedSha256, suppliedSha256: result.suppliedSha256 },
      );
    default:
      return routeNotFoundResponse();
  }
}
