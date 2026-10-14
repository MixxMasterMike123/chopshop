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

/**
 * The byte ceiling a JSON body is read under when its route names no other.
 * Every parser behind readJsonBody refuses a document far smaller than this;
 * the cap exists so a body is never buffered whole before the parser sees it
 * (the 2026-10-14 audit, F02). Routes with a larger document name their own.
 */
export const JSON_BODY_MAX_BYTES = 1_048_576;

export type BoundedBytes = { bytes: Uint8Array | null; status: "ok" } | { status: "too_large" };
export type BoundedBody = { status: "ok"; value: unknown } | { status: "too_large" };

/**
 * A request body read under a byte cap: a declared Content-Length over the cap
 * is refused unread, and a stream is cut off as soon as it passes the cap —
 * so a chunked body with no declared length is bounded as well. `bytes` is
 * null when the request has no body at all.
 */
export async function readBodyWithin(request: Request, maxBytes: number): Promise<BoundedBytes> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return { status: "too_large" };
  }
  if (request.body === null) {
    return { bytes: null, status: "ok" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { status: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, status: "ok" };
}

/**
 * JSON body read under a byte cap. Malformed JSON or UTF-8 reads as
 * `undefined` (the parsers then refuse it).
 */
export async function readJsonBodyWithin(request: Request, maxBytes: number): Promise<BoundedBody> {
  const read = await readBodyWithin(request, maxBytes);
  if (read.status === "too_large") {
    return read;
  }
  if (read.bytes === null) {
    return { status: "ok", value: undefined };
  }
  try {
    return { status: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) };
  } catch {
    return { status: "ok", value: undefined };
  }
}

/**
 * The exact text of a body read under a byte cap, for a caller that verifies
 * a signature over the bytes as sent (the Stripe webhook): the same UTF-8
 * decode `request.text()` performs, over bytes that were never buffered past
 * the cap. Null when the body is over the cap, absent or unreadable.
 */
export async function readTextBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  let read: BoundedBytes;
  try {
    read = await readBodyWithin(request, maxBytes);
  } catch {
    return null;
  }
  if (read.status === "too_large" || read.bytes === null) {
    return null;
  }
  return new TextDecoder("utf-8").decode(read.bytes);
}

/**
 * The JSON body of a route whose parser refuses anything it does not expect.
 * Read under `maxBytes` (JSON_BODY_MAX_BYTES unless the route names its own):
 * a body over the cap reads as `undefined`, exactly like malformed JSON, so
 * the route's parser refuses it with its usual 400 and nothing downstream
 * (D1, a provider) is touched for it.
 */
export async function readJsonBody(request: Request, maxBytes = JSON_BODY_MAX_BYTES): Promise<unknown> {
  const read = await readJsonBodyWithin(request, maxBytes);
  return read.status === "ok" ? read.value : undefined;
}
