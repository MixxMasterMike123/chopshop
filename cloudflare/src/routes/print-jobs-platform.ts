import { authorizePlatformRequest } from "../auth/request-authorization";
import {
  parseProductionStatusInput,
  recordProductionStatus,
} from "../dispatch/production-status";
import { parsePrinterJobId } from "../dispatch/snapwear-wire";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { nudgeOrderMails } from "../outbox/nudge";

export const PLATFORM_PRINT_JOB_STATUS_ROUTE = "/v1/platform/print-jobs/:jobId/status";

/**
 * `POST /v1/platform/print-jobs/{orderId}-{lineNo}/status` (CP6-PS1)
 *   body { state: "in_production" | "produced" | "shipped",
 *          trackingNumber?, trackingUrl?, carrier? }   (tracking: shipped only)
 *   200 { job: PrintJobStatusView, changed: true, orderShipped: boolean }
 *   200 { job: PrintJobStatusView, changed: false, orderShipped: false }
 *       — the same state with the same facts again (idempotent no-op)
 *   409 { error: { code: "print_job_status_not_allowed", reason, message } }
 *       reason ∈ not_accepted | cancelled | refunded | backwards | tracking_differs
 *   409 { error: { code: "conflict", … } }   lost a race twice; retry
 *   400 invalid_request                      the body is not exactly the shape above
 *   404 (opaque)  no session, not a platform user, an X-Shop-Id header, a
 *       cross-site or Origin-less request, any method but POST, a malformed
 *       job id, an unknown order or line, a line that is not a printer line
 *
 * Thin on purpose: the rules are recordProductionStatus's, which a future
 * automated source (SnapWear webhook, mail parser) calls the same way.
 * Recorded with who/when in audit_events (`print_job.status`). When the
 * change also shipped the order (an all-printer parcel order's last line),
 * the buyer's mail is nudged now rather than at the next sweep.
 */
export async function handlePlatformPrintJobStatusRoute(
  env: Env,
  request: Request,
  rawJobId: string,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "POST") {
    return routeNotFoundResponse();
  }

  const jobId = decodeSegment(rawJobId);
  if (jobId === null || parsePrinterJobId(jobId) === null) {
    return routeNotFoundResponse();
  }

  const input = parseProductionStatusInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await recordProductionStatus(env.DB, principal.userId, jobId, input, Date.now());
  switch (result.status) {
    case "not_found":
      return routeNotFoundResponse();
    case "conflict":
      return jsonResponse(
        { error: { code: "conflict", message: "The print job changed meanwhile; try again" } },
        409,
      );
    case "refused":
      return jsonResponse(
        {
          error: {
            code: "print_job_status_not_allowed",
            message: "The print job cannot take this status",
            reason: result.reason,
          },
        },
        409,
      );
    case "unchanged":
      return jsonResponse({ changed: false, job: result.job, orderShipped: false }, 200);
    case "changed":
      if (result.orderShipped) {
        // Never throws; the sweeper is the backstop.
        await nudgeOrderMails(env, result.job.tenantId, result.job.orderId);
      }
      return jsonResponse(
        { changed: true, job: result.job, orderShipped: result.orderShipped },
        200,
      );
  }
}
