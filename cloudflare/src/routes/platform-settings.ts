import type { PlatformPrincipal } from "../auth/live-authorization";
import { authorizePlatformRequest, SHOP_ID_HEADER } from "../auth/request-authorization";
import {
  addScreeningTerm,
  deleteScreeningTerm,
  listScreeningTerms,
  parseAddTermInput,
  parseUpdateTermInput,
  rescreenStaleScreenings,
  termFromKey,
  type TermWriteResult,
  updateScreeningTerm,
} from "../catalog/screening";
import { jsonResponse } from "../lib/http";
import {
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  parsePlatformSettingsPatch,
  readPlatformSettings,
  updatePlatformSettings,
} from "../platform/platform-settings";

/**
 * CP3-D — platform settings and the screening blocklist. PLATFORM session only.
 *
 *   GET    /v1/platform/settings
 *          200 { settings: PlatformSettingsView }
 *   PATCH  /v1/platform/settings   { defaultCommissionBps?, reviewFirstProducts?, screeningHardBlock? }
 *          200 { settings, rescreen: RescreenSummary | null }
 *          400 { error: { code: "setting_not_editable" | "invalid_request", field } }
 *   GET    /v1/platform/screening-terms[?cursor=<termKey>&limit=1..500]
 *          200 { terms: [ScreeningTermView], nextCursor, termsVersion }
 *   POST   /v1/platform/screening-terms   { term, kind?, hardBlock?, note? }
 *          201 { term, rescreen } · 409 duplicate_term | term_limit | conflict
 *   PATCH  /v1/platform/screening-terms/:termKey   { kind?, hardBlock?, note? }
 *          200 { term, rescreen } · 404 unknown term
 *   DELETE /v1/platform/screening-terms/:termKey
 *          200 { deleted: true, rescreen } · 404 unknown term
 *   POST   /v1/platform/screening-terms/rescreen
 *          200 { rescreened, pending, unverified }  (≤ 25 products per call)
 *
 * `:termKey` = base64url of the stored term (termKeyOf; every term view
 * carries it) — see termKeyOf for why a term is not a percent-encoded segment.
 *
 * GUARD (every route here and in platform-reports.ts): the opaque 404 for no
 * session, a tenant admin, a print operator, AND for any request naming a shop
 * in X-Shop-Id — the tenant-context marker every shop-admin client sends, a
 * platform user acting as a shop included. Platform settings and reporter data
 * never flow into a shop-context UI ("the seller sees one number"). Reads need
 * no same-origin (browsers send no Origin on a same-origin GET); every state
 * change does, and a cross-origin one is the same 404.
 */

export const PLATFORM_SETTINGS_PATH = "/v1/platform/settings";
export const PLATFORM_SCREENING_TERMS_PATH = "/v1/platform/screening-terms";
export const PLATFORM_SCREENING_RESCREEN_PATH = "/v1/platform/screening-terms/rescreen";
export const PLATFORM_SCREENING_TERM_ROUTE = "/v1/platform/screening-terms/:termKey";

const TERMS_DEFAULT_LIMIT = 100;
const TERMS_MAX_LIMIT = 500;

/** The platform principal, or null (→ the opaque 404). */
export async function authorizePlatformSurface(
  env: Env,
  request: Request,
): Promise<PlatformPrincipal | null> {
  if (request.headers.has(SHOP_ID_HEADER)) {
    return null;
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  return principal;
}

function termWriteResponse(result: TermWriteResult, successStatus: number): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse(
        result.term === null
          ? { deleted: true, rescreen: result.rescreen }
          : { rescreen: result.rescreen, term: result.term },
        successStatus,
      );
    case "conflict":
      return jsonResponse(
        {
          error: {
            code: result.code,
            message:
              result.code === "duplicate_term"
                ? "The blocklist already has a term that matches the same text"
                : result.code === "term_limit"
                  ? "The blocklist is full"
                  : "The screening settings changed meanwhile; try again",
          },
        },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}

export async function handlePlatformSettingsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    return jsonResponse({ settings: await readPlatformSettings(env.DB) });
  }
  if (request.method !== "PATCH") {
    return routeNotFoundResponse();
  }

  const parsed = parsePlatformSettingsPatch(await readJsonBody(request));
  if (parsed.status === "invalid") {
    return jsonResponse(
      {
        error: {
          code: parsed.code,
          field: parsed.field,
          message:
            parsed.code === "setting_not_editable"
              ? `${parsed.field} is fixed in code in this checkpoint and cannot be changed here`
              : "Request is not valid",
        },
      },
      400,
    );
  }
  const result = await updatePlatformSettings(env.DB, principal, parsed.patch, Date.now());
  if (result.status === "conflict") {
    return jsonResponse(
      { error: { code: "conflict", message: "The screening settings changed meanwhile; try again" } },
      409,
    );
  }
  return jsonResponse({ rescreen: result.rescreen, settings: result.settings });
}

export async function handlePlatformScreeningTermsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "cursor" && key !== "limit")) {
      return invalidRequestResponse();
    }
    const limitRaw = params.get("limit");
    const limit = limitRaw === null ? TERMS_DEFAULT_LIMIT : Number(limitRaw);
    if (!/^\d{1,3}$/.test(limitRaw ?? "1") || limit < 1 || limit > TERMS_MAX_LIMIT) {
      return invalidRequestResponse();
    }
    const cursorRaw = params.get("cursor");
    const cursor = cursorRaw === null ? null : termFromKey(cursorRaw);
    if (cursorRaw !== null && cursor === null) {
      return invalidRequestResponse();
    }
    return jsonResponse(await listScreeningTerms(env.DB, { cursor, limit }));
  }

  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const input = parseAddTermInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return termWriteResponse(await addScreeningTerm(env.DB, principal, input, Date.now()), 201);
}

export async function handlePlatformScreeningTermRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  // "", "v1", "platform", "screening-terms", :termKey — from the RAW path.
  const segments = new URL(request.url).pathname.split("/");
  const term = segments.length === 5 ? termFromKey(segments[4] ?? "") : null;
  if (term === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "DELETE") {
    return termWriteResponse(await deleteScreeningTerm(env.DB, principal, term, Date.now()), 200);
  }
  if (request.method !== "PATCH") {
    return routeNotFoundResponse();
  }
  const input = parseUpdateTermInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return termWriteResponse(await updateScreeningTerm(env.DB, principal, term, input, Date.now()), 200);
}

/** Drives the bounded re-screen sweep by hand (the cron does the same). */
export async function handlePlatformScreeningRescreenRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  return jsonResponse(await rescreenStaleScreenings(env.DB, Date.now()));
}
