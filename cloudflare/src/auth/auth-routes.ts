import { createAuth, isAuthConfigured } from "./create-auth";
import {
  canonicalResetLinkRequest,
  handleRequestPasswordReset,
  isPasswordResetConfigured,
} from "./password-reset";
import { readCanonicalOrigins } from "../lib/origins";
import { routeNotFoundResponse } from "../lib/responses";

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
    return createAuth(env).handler(request);
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

  if (route === REQUEST_PASSWORD_RESET) {
    return handleRequestPasswordReset(env, request, (forwarded) =>
      auth.handler(forwarded),
    );
  }

  if (isResetLink) {
    return auth.handler(canonicalResetLinkRequest(request, origins));
  }

  return auth.handler(request);
}
