import {
  parseDiscountPreviewInput,
  previewDiscount,
} from "../commerce/discount-preview";
import { printCanvasEnabled } from "../dispatch/print-canvas";
import { readJsonBodyWithin } from "../legal/legal-pages";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  routeNotFoundResponse,
} from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP8-DC — the discount preview (design §4.1). A storefront route: mounted
 * inside app.ts's `storefront(...)` wrapper, no session, the tenant from the
 * verified hostname as the checkout resolves it, and nothing else.
 *
 *   POST /v1/discount-codes/preview
 *     { code, items: [{ productId, quantity, variantId? }] }
 *     200 { discount: { applies: true,  code, discountMinor } }   it applies
 *     200 { discount: { applies: false, code, discountMinor: 0 } } every other
 *                                  case, one body (discount-preview.ts)
 *     400 invalid_request          a malformed body or code (decided without
 *                                  the database)
 *     404 (the opaque one)         no shop for the hostname, or one that takes
 *                                  no checkout; any method but POST
 *     422 unprocessable            a line cannot be bought (the checkout's own
 *                                  answer)
 *     429 rate_limited             the 31st preview from one visitor within
 *                                  10 minutes
 *
 * No same-origin check, as for checkout: the surface is anonymous by design
 * and carries no ambient credential. Nothing is written but the limiter's row.
 *
 * ── THE RATE LIMIT (DC16) ───────────────────────────────────────────────────
 * 30 per 10 minutes per visitor (an IPv6 address by its /64, the withdrawal
 * intake's key), BEFORE the body is read, so every guess counts, the refused
 * ones too. The checkout counts code-carrying bodies on a limit of its own
 * (app.ts DISCOUNT_ATTEMPT_*), so neither route is the faster oracle.
 */

export const STOREFRONT_DISCOUNT_PREVIEW_PATH = "/v1/discount-codes/preview";

export const DISCOUNT_PREVIEW_IP_SCOPE = "discount-preview-ip";
export const DISCOUNT_PREVIEW_IP_LIMIT = 30;
export const DISCOUNT_PREVIEW_IP_WINDOW_MS = 10 * 60 * 1_000;

/** A code and at most 50 short lines; anything larger is not a preview. */
export const DISCOUNT_PREVIEW_BODY_MAX_BYTES = 32_768;

function unprocessableResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: "unprocessable",
        message: "Request could not be processed",
      },
    },
    422,
  );
}

export async function handleStorefrontDiscountPreviewRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return routeNotFoundResponse();
  }

  const now = options.now ?? Date.now();
  const byVisitor = await enforceRateLimit(env.DB, {
    key: visitorRateKey(clientIp(request)),
    limit: DISCOUNT_PREVIEW_IP_LIMIT,
    now,
    scope: DISCOUNT_PREVIEW_IP_SCOPE,
    windowMs: DISCOUNT_PREVIEW_IP_WINDOW_MS,
  });
  if (!byVisitor.allowed) {
    return rateLimitedResponse(byVisitor.retryAfterSeconds);
  }

  const body = await readJsonBodyWithin(request, DISCOUNT_PREVIEW_BODY_MAX_BYTES);
  const input = body.status === "ok" ? parseDiscountPreviewInput(body.value) : null;
  if (input === null) {
    return invalidRequestResponse();
  }

  // The checkout route's own switch (CP6-PS3/PS4): with the print canvas on,
  // a line on a stand-in frame cannot be bought, so it is not previewed.
  const result = await previewDiscount(env.DB, tenant, input, now, printCanvasEnabled(env));
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "invalid_items") {
    return unprocessableResponse();
  }
  return jsonResponse({ discount: result.discount });
}
