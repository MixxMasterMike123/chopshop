/**
 * Cookie-authenticated state changes must be same-origin. The check is strict on
 * purpose: a missing, opaque ("null") or mismatched Origin header fails closed,
 * so a cross-site form post can never reach a mutation handler.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) {
    return false;
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  return origin === requestOrigin;
}
