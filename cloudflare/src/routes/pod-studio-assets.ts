import {
  authorizePlatformRequest,
  authorizeTenantAdminRequest,
  SHOP_ID_HEADER,
} from "../auth/request-authorization";
import type { PlatformPrincipal } from "../auth/live-authorization";
import { jsonResponse } from "../lib/http";
import { decodeSegment, readJsonBody, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  isModelId,
  isTemplateId,
  listPlatformModels,
  listPlatformTemplates,
  listSellerModels,
  listSellerTemplates,
  parseActiveInput,
  parseMockupTemplateInput,
  parseModel3dInput,
  putMockupTemplate,
  putModel3d,
  setMockupTemplateActive,
  setModel3dActive,
} from "../pod/studio-assets";
import { isStudioFileStoreConfigured, uploadStudioFile } from "../pod/studio-files";

/**
 * The design studio's platform-owned assets (CP5-WH, D101; src/pod/studio-assets.ts):
 *
 *   SELLER (tenant admin session + X-Shop-Id, the guard of every
 *   /v1/admin/pod/* product route; GET only):
 *     GET   /v1/admin/pod/mockup-templates        → { provisional, templates }
 *     GET   /v1/admin/pod/3d-models               → { models }
 *
 *   PLATFORM (live platform_admin session, NO X-Shop-Id — D70; same-origin on
 *   every state change):
 *     POST  /v1/platform/pod/studio-files         raw image bytes → 201|200 { file }
 *     GET   /v1/platform/pod/mockup-templates     → { templates, files }
 *     PUT   /v1/platform/pod/mockup-templates/:templateId  → 201|200 { template, changed }
 *     PATCH /v1/platform/pod/mockup-templates/:templateId  { active } → 200 { template, changed }
 *     GET   /v1/platform/pod/3d-models            → { models, files }
 *     PUT   /v1/platform/pod/3d-models/:modelId   → 201|200 { model, changed }
 *     PATCH /v1/platform/pod/3d-models/:modelId   { active } → 200 { model, changed }
 *
 * Every guard failure — no session, a tenant session on a platform route, a
 * platform route that names a shop, a cross-origin state change, a method a
 * path does not own — is the one opaque 404, before any body is read. No
 * tenant route writes or deletes a platform asset: there is none.
 */
export const ADMIN_POD_MOCKUP_TEMPLATES_PATH = "/v1/admin/pod/mockup-templates";
export const ADMIN_POD_3D_MODELS_PATH = "/v1/admin/pod/3d-models";
export const PLATFORM_POD_STUDIO_FILES_PATH = "/v1/platform/pod/studio-files";
export const PLATFORM_POD_MOCKUP_TEMPLATES_PATH = "/v1/platform/pod/mockup-templates";
export const PLATFORM_POD_MOCKUP_TEMPLATE_ROUTE = "/v1/platform/pod/mockup-templates/:templateId";
export const PLATFORM_POD_3D_MODELS_PATH = "/v1/platform/pod/3d-models";
export const PLATFORM_POD_3D_MODEL_ROUTE = "/v1/platform/pod/3d-models/:modelId";

// A template or a model document is a few kilobytes; this is generous.
const ASSET_BODY_MAX_BYTES = 256 * 1024;

function errorResponse(status: number, code: string, message: string, reason?: string): Response {
  return jsonResponse(
    { error: reason === undefined ? { code, message } : { code, message, reason } },
    status,
  );
}

function invalidResponse(reason?: string): Response {
  return errorResponse(400, "invalid_request", "Request is not valid", reason);
}

function tooLargeResponse(): Response {
  return errorResponse(413, "payload_too_large", "The request exceeds the maximum allowed size");
}

/** The seller reads: a live tenant-admin session in the shop X-Shop-Id names. */
export async function handleAdminStudioAssetsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const { pathname } = new URL(request.url);
  if (pathname === ADMIN_POD_MOCKUP_TEMPLATES_PATH) {
    return jsonResponse(await listSellerTemplates(env, env.DB));
  }
  if (pathname === ADMIN_POD_3D_MODELS_PATH) {
    return jsonResponse(await listSellerModels(env, env.DB));
  }
  return routeNotFoundResponse();
}

/**
 * The platform guard, in this order: no X-Shop-Id (a tenant-admin request,
 * acting-as included, is never a platform request), a live platform_admin
 * session, the method, same-origin on a state change.
 */
async function guardPlatform(
  env: Env,
  request: Request,
  methods: readonly string[],
): Promise<PlatformPrincipal | null> {
  if (request.headers.has(SHOP_ID_HEADER)) {
    return null;
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !methods.includes(request.method)) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  return principal;
}

/** POST /v1/platform/pod/studio-files — dark (404) without the public bucket and address. */
export async function handlePlatformStudioFileRoute(env: Env, request: Request): Promise<Response> {
  if (!isStudioFileStoreConfigured(env)) {
    return routeNotFoundResponse();
  }
  const principal = await guardPlatform(env, request, ["POST"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const result = await uploadStudioFile(env, principal, request, Date.now());
  switch (result.status) {
    case "ok":
      return jsonResponse({ file: result.file }, result.created ? 201 : 200);
    case "invalid":
      return invalidResponse(result.reason);
    case "too_large":
      return tooLargeResponse();
    case "conflict":
      return errorResponse(409, "conflict", "The same file is being uploaded; try again");
    case "unavailable":
      return routeNotFoundResponse();
  }
}

async function readBoundedJson(request: Request): Promise<unknown | "too_large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]{1,15}$/.test(declared) && Number(declared) > ASSET_BODY_MAX_BYTES) {
    return "too_large";
  }
  return readJsonBody(request);
}

function idSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  return decodeSegment(pathname.slice(prefix.length));
}

export async function handlePlatformMockupTemplatesRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guardPlatform(env, request, ["GET"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  return jsonResponse(await listPlatformTemplates(env, env.DB));
}

export async function handlePlatformMockupTemplateRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guardPlatform(env, request, ["PATCH", "PUT"]);
  const templateId = idSegment(new URL(request.url).pathname, `${PLATFORM_POD_MOCKUP_TEMPLATES_PATH}/`);
  if (principal === null || !isTemplateId(templateId)) {
    return routeNotFoundResponse();
  }
  const body = await readBoundedJson(request);
  if (body === "too_large") {
    return tooLargeResponse();
  }
  const now = Date.now();

  if (request.method === "PATCH") {
    const active = parseActiveInput(body);
    if (active === null) {
      return invalidResponse();
    }
    const result = await setMockupTemplateActive(env.DB, principal, templateId, active, now);
    return result.status === "ok"
      ? jsonResponse({ changed: result.changed, template: result.value })
      : routeNotFoundResponse();
  }

  const parsed = parseMockupTemplateInput(body);
  if (parsed.status !== "ok") {
    return invalidResponse(parsed.reason);
  }
  const result = await putMockupTemplate(env.DB, principal, templateId, parsed.input, now);
  if (result.status === "invalid") {
    return invalidResponse(result.reason);
  }
  if (result.status === "limit") {
    return errorResponse(409, "limit_reached", "The platform holds the most templates it may");
  }
  return jsonResponse({ changed: result.changed, template: result.value }, result.created ? 201 : 200);
}

export async function handlePlatformModelsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guardPlatform(env, request, ["GET"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  return jsonResponse(await listPlatformModels(env, env.DB));
}

export async function handlePlatformModelRoute(env: Env, request: Request): Promise<Response> {
  const principal = await guardPlatform(env, request, ["PATCH", "PUT"]);
  const modelId = idSegment(new URL(request.url).pathname, `${PLATFORM_POD_3D_MODELS_PATH}/`);
  if (principal === null || !isModelId(modelId)) {
    return routeNotFoundResponse();
  }
  const body = await readBoundedJson(request);
  if (body === "too_large") {
    return tooLargeResponse();
  }
  const now = Date.now();

  if (request.method === "PATCH") {
    const active = parseActiveInput(body);
    if (active === null) {
      return invalidResponse();
    }
    const result = await setModel3dActive(env.DB, principal, modelId, active, now);
    return result.status === "ok"
      ? jsonResponse({ changed: result.changed, model: result.value })
      : routeNotFoundResponse();
  }

  const parsed = parseModel3dInput(body);
  if (parsed.status !== "ok") {
    return invalidResponse(parsed.reason);
  }
  const result = await putModel3d(env.DB, principal, modelId, parsed.input, now);
  if (result.status === "invalid") {
    return invalidResponse(result.reason);
  }
  if (result.status === "limit") {
    return errorResponse(409, "limit_reached", "The platform holds the most models it may");
  }
  return jsonResponse({ changed: result.changed, model: result.value }, result.created ? 201 : 200);
}
