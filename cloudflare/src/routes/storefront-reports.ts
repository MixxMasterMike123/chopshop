import { parseReportSubmission, submitReport } from "../catalog/infringement-reports";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  notFoundResponse,
  rateLimitedResponse,
  readJsonBody,
} from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP3-D — the public infringement-report intake (DECISIONS D58; the page is
 * CP6). A storefront route: mounted inside app.ts's `storefront(...)` wrapper,
 * tenant from the verified hostname and nothing else.
 *
 *   POST /v1/reports
 *     { productId, reporterName, reporterOrg?, reporterEmail, rightType,
 *       description, attestation: true, productUrl?, website: "" }
 *     201 { report: { reportId } }   the case reference, nothing else
 *     400 invalid_request            ANY refusal of the body — malformed, no
 *                                    attestation, a filled honeypot, a product
 *                                    that is unknown or another shop's — one
 *                                    answer, so a caller cannot tell which
 *     404                            the hostname is no active storefront
 *     429                            6th request from one IP within the hour
 *
 * No session and no same-origin check, as for checkout: the surface accepts
 * anonymous rights holders by design and carries no ambient credential.
 *
 * The IP limit (Firebase: 5 per hour, `checkRateLimit('infringement', …)`)
 * runs BEFORE the body is parsed, so a flood is refused without the work it
 * tries to provoke and every attempt counts, the refused ones included. The
 * IP is the limiter's key only (stored hashed, with the scope, by
 * src/lib/rate-limit.ts) and never reaches the report.
 */

export const STOREFRONT_REPORTS_PATH = "/v1/reports";
export const REPORT_IP_SCOPE = "report-ip";
export const REPORT_IP_LIMIT = 5;
export const REPORT_IP_WINDOW_MS = 60 * 60 * 1_000;

export async function handleStorefrontReportRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return notFoundResponse("Route not found");
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return notFoundResponse("Route not found");
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: REPORT_IP_LIMIT,
    now,
    scope: REPORT_IP_SCOPE,
    windowMs: REPORT_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const input = parseReportSubmission(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await submitReport(env.DB, tenant, input, now);
  if (result.status !== "ok") {
    return invalidRequestResponse();
  }
  return jsonResponse({ report: { reportId: result.reportId } }, 201);
}
