/**
 * The request this Worker hands the API, and what it does to the answer.
 *
 * Forwarded as it came (method, body, headers) with four changes:
 *   - every `X-Tenant-*` header is dropped (PLAN §2.1: a tenant is never
 *     request-supplied; the API strips them too, this is the first fence);
 *   - `Cookie` is dropped: the storefront holds no session, and no cookie of
 *     this host is the API's business. `Authorization` stays: the receipt of
 *     an order is read with its bearer token (src/commerce/receipts.ts);
 *   - `CF-Connecting-IP` is set to the visitor's address as the edge gave it
 *     to THIS Worker, so the API's rate limits count the visitor, not the
 *     Worker (brief E rule 6);
 *   - a body is sent only when there is one: a POST that declares
 *     `Content-Length: 0` goes on with no body at all, because the payment
 *     route refuses a request that carries a body stream (src/app.ts,
 *     handleCheckoutPaymentRoute).
 */

const TENANT_HEADER_PATTERN = /^x-tenant-/i;
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// A Response with one of these statuses must be built with a null body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function forwardedApiRequest(
  request: Request,
  target: string,
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (TENANT_HEADER_PATTERN.test(name)) {
      headers.delete(name);
    }
  }

  headers.delete("cookie");

  const visitor = request.headers.get("cf-connecting-ip");
  if (visitor === null) {
    headers.delete("cf-connecting-ip");
  } else {
    headers.set("cf-connecting-ip", visitor);
  }

  const sendsBody =
    !BODYLESS_METHODS.has(request.method) &&
    request.body !== null &&
    request.headers.get("content-length") !== "0";
  if (!sendsBody) {
    headers.delete("content-length");
  }

  return new Request(target, {
    body: sendsBody ? request.body : null,
    headers,
    method: request.method,
    redirect: "manual",
  });
}

/**
 * A request this Worker makes on its own behalf (the head of a page, the
 * sitemap): GET, JSON, the visitor's address, nothing else of the browser's.
 */
export function workerApiRequest(target: string, visitor: string | null): Request {
  const headers = new Headers({ accept: "application/json" });
  if (visitor !== null) {
    headers.set("cf-connecting-ip", visitor);
  }
  return new Request(target, { headers, method: "GET" });
}

/**
 * The API's answer as the browser gets it: status, body, `ETag`,
 * `Cache-Control` and `Retry-After` untouched (the browser revalidates by ETag,
 * PLAN §2.4); `Set-Cookie` removed, because no storefront route sets one and
 * the storefront holds no session.
 */
export function apiResponseForBrowser(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
