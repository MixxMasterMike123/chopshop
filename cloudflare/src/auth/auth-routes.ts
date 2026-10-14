import { createAuth, isAuthConfigured } from "./create-auth";
import {
  canonicalResetLinkRequest,
  handleRequestPasswordReset,
  isPasswordResetConfigured,
} from "./password-reset";
import { readCanonicalOrigins } from "../lib/origins";
import { readBodyWithin, routeNotFoundResponse } from "../lib/responses";

const AUTH_PATH_PREFIX = "/api/auth/";

// Sign-up is deliberately absent: accounts are created by invitation and
// provisioning flows, so public registration stays closed. Every endpoint not
// named here (verification, social, account management, sign-up) stays
// unmounted, so these allowlists are the only gate and match on exact strings.
const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/auth/get-session",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
]);

// Password reset (src/auth/password-reset.ts). Mounted only while its delivery
// path is configured; otherwise these answer exactly like the unmounted rest.
const REQUEST_PASSWORD_RESET = "POST /api/auth/request-password-reset";
const SUBMIT_PASSWORD_RESET = "POST /api/auth/reset-password";
// The emailed link. Better Auth mints the token with generateId(24) — an
// alphanumeric string — so the segment is held to a narrow alphabet and length
// rather than "anything but a slash".
const RESET_LINK_PATH = /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]{16,128}$/;

/**
 * The most an auth request body is buffered (F02, the 2026-10-14 audit). The
 * largest honest body here is a sign-in or a reset submission: an email, a
 * password and a callback address, well under a kilobyte. Better Auth reads
 * the body itself, so the bound is applied before the handler sees it.
 */
export const AUTH_BODY_MAX_BYTES = 16_384;

/**
 * The request with its body read under AUTH_BODY_MAX_BYTES, or null when the
 * body is over it. The copy carries the original's method, URL and headers,
 * so Better Auth's origin and cookie checks see exactly what was sent.
 */
async function boundedAuthRequest(request: Request): Promise<Request | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return request;
  }
  const read = await readBodyWithin(request, AUTH_BODY_MAX_BYTES);
  if (read.status === "too_large") {
    return null;
  }
  return new Request(request, { body: read.bytes === null ? null : (read.bytes as Uint8Array<ArrayBuffer>) });
}

export async function handleAuthRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith(AUTH_PATH_PREFIX)) {
    return null;
  }

  // Without a configured secret no session can exist, so the whole namespace
  // fails closed instead of throwing out of createAuth.
  if (!isAuthConfigured(env)) {
    return routeNotFoundResponse();
  }

  const route = `${request.method} ${url.pathname}`;

  if (ALLOWED_AUTH_ROUTES.has(route)) {
    const bounded = await boundedAuthRequest(request);
    return bounded === null ? payloadTooLargeResponse() : createAuth(env).handler(bounded);
  }

  const isResetLink =
    request.method === "GET" && RESET_LINK_PATH.test(url.pathname);
  if (
    route !== REQUEST_PASSWORD_RESET &&
    route !== SUBMIT_PASSWORD_RESET &&
    !isResetLink
  ) {
    return routeNotFoundResponse();
  }

  const origins = readCanonicalOrigins(env);
  if (!isPasswordResetConfigured(env) || origins === null) {
    return routeNotFoundResponse();
  }

  const auth = createAuth(env);

  if (isResetLink) {
    return auth.handler(canonicalResetLinkRequest(request, origins));
  }

  const bounded = await boundedAuthRequest(request);
  if (bounded === null) {
    return payloadTooLargeResponse();
  }

  if (route === REQUEST_PASSWORD_RESET) {
    return handleRequestPasswordReset(env, bounded, (forwarded) =>
      auth.handler(forwarded),
    );
  }

  return auth.handler(bounded);
}

/** The one answer a body over the cap gets: nothing of it was parsed. */
function payloadTooLargeResponse(): Response {
  return Response.json(
    { error: { code: "payload_too_large", message: "Request body is too large" } },
    { status: 413 },
  );
}
