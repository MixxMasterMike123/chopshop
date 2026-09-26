import { createAuth, isAuthConfigured } from "./create-auth";
import { jsonResponse } from "../lib/http";

const AUTH_PATH_PREFIX = "/api/auth/";

// Sign-up is deliberately absent: accounts are created by invitation and
// provisioning flows, so public registration stays closed. Every other Better
// Auth endpoint (password reset, verification, social) stays unmounted too, so
// the allowlist is the only gate and matches on exact strings.
const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/auth/get-session",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
]);

function notFoundResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    },
    404,
  );
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
    return notFoundResponse();
  }

  if (!ALLOWED_AUTH_ROUTES.has(`${request.method} ${url.pathname}`)) {
    return notFoundResponse();
  }

  return createAuth(env).handler(request);
}
