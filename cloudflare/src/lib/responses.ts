import { jsonResponse } from "./http";

/**
 * The response and request helpers every route module shares.
 *
 * Moved verbatim out of the old `src/index.ts` if-chain when routing moved to
 * Hono (src/app.ts), so that route modules added since can answer with exactly
 * the same shapes rather than growing their own near-copies. Nothing here knows
 * about a route; each function is one fixed response or one parsing rule.
 */

export function notFoundResponse(message: string): Response {
  return jsonResponse(
    {
      error: {
        code: "not_found",
        message,
      },
    },
    404,
  );
}

/**
 * The one opaque 404 every guarded surface answers with. A caller that fails a
 * session, membership, same-origin or configuration gate learns exactly what a
 * caller probing a route that was never written learns.
 */
export function routeNotFoundResponse(): Response {
  return notFoundResponse("Route not found");
}

export function invalidRequestResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "invalid_request",
        message: "Request is not valid",
      },
    },
    400,
  );
}

/**
 * The message names no limit, no window and no remaining allowance: telling a
 * caller which of several limits it tripped would let it map the limiter and
 * tune around it. Retry-After is the one hint given, because an honest client
 * needs it to back off correctly.
 */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  const response = jsonResponse(
    {
      error: {
        code: "rate_limited",
        message: "Too many requests",
      },
    },
    429,
  );

  response.headers.set("Retry-After", retryAfterSeconds.toString());
  return response;
}

export function decodeSegment(segment: string): string | null {
  if (segment.length === 0 || segment.includes("/")) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }

  return decoded.length > 0 && !decoded.includes("/") ? decoded : null;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json<unknown>();
  } catch {
    return undefined;
  }
}
